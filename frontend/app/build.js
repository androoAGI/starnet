/* STARNET — build.js : the diegetic full-screen BUILD MODE (build) mode.

   Toggled from the dock. Dims the live sim and drops the Commander into an in-fiction
   station-editor over the SAME procedural art: pan/zoom camera, phosphor build grid,
   a ghost preview that snaps to tiles and tints green/red via the model's validators,
   and an in-fiction toolbar — PLACE ROOM · HALLWAY · SURFACE · DELETE · UNDO (SELECT moves: drag a selected piece).

   It reads + mutates the canonical WorldModel station (the single source of truth) and
   re-bakes the environment when changed, then persists through the injected save hook.
   See frontend/app/BUILDER.md for the contract. */
'use strict';

const Build = (() => {
  const TOOLS = [
    // SELECT is the DEFAULT mode (2026-08-05 interaction reshape): entering BUILD MODE arms NO placement
    // tool — a click INSPECTS the machine under it (its picker/editor/flow card) instead of trying to
    // place something. Key 0, ESC and right-click all return here from any armed tool.
    // labels are WORDS ONLY — the leading symbol each one used to carry (◎ ▦ ═ …) is now a pixel
    // icon painted on the button's canvas, because those glyphs fall back to a system font
    /* SELECT MOVES (Andrew 10-11: "rather than a move button, which is annoying can we just make the select button allow the
       user to move"). The MOVE tool (it was key 4) is retired: click a piece to select it, then drag it to move it (a selection
       moves together, its belts re-laid); a machine dragged ONTO another machine lays a belt (THE HAND) — selected or not, the target
       decides (refine 10-11); Shift+drag moves anything; a selected ROOM moves by a drag inside it. Key 4 stays free — no other
       tool's number changed. */
    { id: 'select', key: '0', label: 'SELECT', verb: 'click to select · drag a machine onto another to belt them · drag a selected piece onto open floor to move it', hint: 'click to select · drag a selected piece to move it · drag a box to select several', cursor: 'default' },
    { id: 'room', key: '1', label: 'ROOM', verb: 'click to place · drag to size', hint: 'click the deck to place a room at the last size you drew, or drag out any size', cursor: 'crosshair' },
    { id: 'hall', key: '2', label: 'HALLWAY', verb: 'click to run · drag to size', hint: 'click to run a corridor at the last length you drew, or drag along an axis for any length', cursor: 'crosshair' },
    // 'paint' stays the INTERNAL id (the drag mode, the model's paintTiles verb, the key map and every
    // saved reference key off it) — only the display name changed. The tool stopped being "paint" the
    // day it grew wall cladding and a material axis: it now sets what a room's surfaces are MADE OF,
    // deck and walls, so it's SURFACE. Same law as the skynet.* keys: rename the label, never the key.
    { id: 'paint', key: '3', label: 'SURFACE', verb: 'click a room to lay this deck', hint: 'click a room to lay the selected deck · drag to paint single tiles in the colour', cursor: 'cell' },
    /* DELETE, not RECLAIM (2026-08-07). "Reclaim" is salvage-economy fiction from a tier system
       that was never built — the button's whole job is to remove a thing, and every player already
       knows the word for that. Same law as SURFACE above: the LABEL changed, the tool id `reclaim`
       did not (the key map, the drag mode, the model verb and every saved reference key ride it). */
    { id: 'reclaim', key: '5', label: 'DELETE', verb: 'click anything to delete it', hint: 'click a room, prop, or belt to delete it · drag across a belt to clear the whole run (UNDO restores it)', cursor: 'not-allowed' },
    { id: 'prop', key: '6', label: 'PROPS', verb: 'click the deck to place it', hint: 'browse equipment and decoration, then click the deck to place your selection', cursor: 'crosshair' },
    { id: 'belt', key: '7', label: 'BELT', verb: 'click one machine, then another · or drag across the floor to lay belt by hand', hint: 'CLICK one machine, then another — the belt lays itself · (or drag to lay tiles by hand)', cursor: 'crosshair' },
    { id: 'dupe', key: '8', label: 'COPY', verb: 'click a room or prop to copy it', hint: 'click a room or prop to copy it · then every click stamps a copy — mirror your build fast', cursor: 'copy' },
    { id: 'line', key: '9', label: 'CONVEYOR LINES', verb: 'choose a conveyor line below, then click clear floor to place it', hint: 'add connected workflow equipment to your existing station — choose a line, then place it on clear floor', cursor: 'copy' },
  ];
  // Every tool stays visible. The Select landing offers two starting points without
  // arming a placement tool. Shortcut numbers remain compatible with the guide/tutorial.

  /* ---------- PIXEL TOOL ICONS ----------
     Every tool used to label itself with a unicode symbol (◎ ▦ ═ ▧ ✥ ⌫ ⚇ ⇶ ⧉ ⇉). Those glyphs are
     NOT in VT323 — the browser silently falls back to a system font for the symbol and keeps VT323
     for the word, so each button rendered in two typefaces at two weights (the standing
     symbol-glyph law). These are 12×12 pixel bitmaps painted on a canvas in the button's own
     phosphor colour: one typeface, in the station's own art language, crisp at any DPR. */
  const ICON_PX = [
    ['select', '#...........,##..........,###.........,####........,#####.......,######......,#######.....,########....,#####.......,##.###......,#...###.....,.....###....'],
    ['room',   '############,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#####..#####'],
    ['hall',   '............,............,............,############,............,..##..##..##,............,............,############,............,............,............'],
    ['paint',  '############,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,############'],
    // a BIN, not an X — an X reads "cancel/close"; a bin reads "delete", in every UI there is
    ['reclaim','....####....,############,............,.##########.,.#.##..##.#.,.#.##..##.#.,.#.##..##.#.,.#.##..##.#.,.#.##..##.#.,.#........#.,..########..,............'],
    ['prop',   '..########..,..#......#..,..#.####.#..,..#.####.#..,..#......#..,..########..,.....##.....,.....##.....,############,#..........#,#..........#,############'],
    ['belt',   '............,............,############,............,.##..##..##.,..##..##..##,.##..##..##.,............,############,............,............,............'],
    ['dupe',   '............,..########..,..#......#..,..#......#..,..#..#######,..#..#....#.,..####....#.,.....#....#.,.....#....#.,.....######.,............,............'],
    ['line',   '............,.##########.,.#........#.,.#.##..##.#.,.#.##..##.#.,.#........#.,.#..####..#.,.#..####..#.,.#........#.,.##########.,............,............'],
  ].reduce((m, [k, v]) => (m[k] = v.split(','), m), {});
  const ICON_N = 12;   // bitmap side, in icon pixels

  // Paint a tool's bitmap into its <canvas> in `colour`. Re-run on activation so the icon tracks
  // the button's own phosphor state (dim → bright) instead of being baked once at build time.
  function paintIcon(cvEl, id, colour) {
    const rows = ICON_PX[id]; if (!cvEl || !rows) return;
    const c = cvEl.getContext('2d'); if (!c) return;
    const s = cvEl.width / ICON_N;
    c.clearRect(0, 0, cvEl.width, cvEl.height);
    c.fillStyle = colour;
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) if (row[x] === '#') c.fillRect(x * s, y * s, s, s);
    }
  }
  // the icon colour for a tool button in its current state — read off the live button so a theme
  // switch (or the DELETE red) is honoured without a second colour table to keep in sync
  const iconColour = btn => getComputedStyle(btn).color || '#f0e6ce';
  function repaintIcons() {
    if (!root) return;
    root.querySelectorAll('.refit-tool').forEach(b => {
      const c = b.querySelector('canvas');
      if (c) paintIcon(c, b.dataset.tool, iconColour(b));
    });
  }

  const SEEN_KEY = 'starnet.refit.seen';
  const PREVIEW_LABEL = '▶ TEST';   // 2026-09-28: ONE test control (the name kept: the guide and Field Manual quote it) — it opens the line's TEST view (WATCH IT free · STEP THROUGH · SEND A REAL JOB) and plays the free walkthrough   // the top-bar preview button — the guide and Field Manual name it by this constant
  // machines the BELT tool connects with two clicks (mirrors worldmodel CONNECTABLE)
  const CONNECT_TYPES = { intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 };

  let opts = null, station = null, unsub = null;
  let connectFrom = null;   // connect-mode state: the armed FROM machine's propId (null = not connecting)
  let connectTo = null;     // JOIN A LINE (2026-10-09): a lone BAY armed as the DESTINATION — the next machine clicked is what hands it work
  let root, cv, ctx, tip, hintEl, undoBtn, redoBtn, propCard, dpr = 1, ro = null;
  let raf = 0, frameRetryTimer = 0, running = false, frameFailures = 0;
  let cache = null, cacheGeo = null, bakeDirty = true, bakeDirtyRects = null, bakeDirtyRectsGlobal = false, bakeVisibleOnly = false, valPlan = null, valLive = null;   // valPlan = live RoutingPlan (cost-safety ghosts); valLive = energized-belt tile set
  const sceneRenderer = typeof WorldRenderer !== 'undefined' ? WorldRenderer.create() : null;
  let planDirty = true;   // routing-plan cache flag: set by EDITS (station.onChange / open), never by pure pans — see rebake()
  let projectionDirty = false;
  const flashes = [];   // {rects, t0, bad} place/delete confirmations
  // short human labels for the routing-validation overlay (cost-safety: surfaced before any paid run)
  // every label NAMES THE FIX, in words (mirrors world.js NAG_LABEL — keep the two in sync)
  const VAL_LABEL = {
    // ORPHAN_BAY names its fix (2026-10-09 P0: NOT ON THE LINE said what was wrong, never what to do)
    ORPHAN_SOURCE: 'NOT CONNECTED — DRAG IT ONTO A BAY', ORPHAN_BAY: 'NOT ON A LINE — BELT INTO IT',
    // a belt that only TOUCHES the junction corner feeds nothing: the lane must run THROUGH the junction tile
    // (SHORT on the floor — the full sentence rides the hover card, VAL_WHY: the long form ran wider than a room)
    BAY_NOT_FED: 'NOT FED — BELT INTO IT',
    // the belt into it starts inside the ring of the machine feeding it (placed a tile apart), so moving it is the fix
    BAY_TOO_CLOSE: 'TOO CLOSE — MOVE IT 1 TILE AWAY',
    CYCLE: 'LOOP! — BREAK THE CIRCLE', FILTER_NO_DEFAULT: 'NO DEFAULT LANE — CLICK', SPLIT_CREW: 'PLACE A DESK — TOOLS FOLLOW THE DOCK',
    UNBOUND_BAY: 'NO AGENT — CLICK', SPLIT_ONE_LANE: 'NEEDS 2 OUT-LANES',
    JOIN_ONE_LANE: 'NEEDS 2 IN-LANES',
    // the done lane defaults to the FIRST exit (E, S, W, N order); this only fires with no exit, or a done set to a non-exit
    LOOP_NO_DONE: 'NO DONE LANE',
    LOOP_NO_BACK: 'NO BACK LANE',
    // a junction touching no belt is fixed by belting into it (a junction moved onto the belt of a line is refused — it would take that
    // line: ANOTHER BELT RUNS HERE), so the nag names that gesture, never the refused move (wave 2, build-06)
    ORPHAN_JUNCTION: 'NOT ON A BELT — BELT INTO IT',
    BELT_BURIED: 'A PROP SITS ON THIS LINE — MOVE IT',
    // the docks feed each OTHER: no belt loop anywhere, but the work line would run forever, paying each lap
    CHAIN_CYCLE: 'WORK LINE LOOPS — CUT ONE HANDOFF',
    // the longest way through this line runs more stages than its stage ceiling: a job that goes that way stops part-way (2026-10-09 P0) — said on its INBOX
    LINE_TOO_LONG: 'TOO LONG — RAISE THE LINE BUDGET',
    // SEND TO (2026-10-10) — said on the OUTBOX whose hand-off is off; advice, never a blocker
    SEND_TO_MISSING: 'SENDS NOWHERE — PICK A LINE', SEND_TO_SELF: 'SENDS TO ITSELF — PICK ANOTHER LINE',
    SEND_TO_LOOP: 'SENDS IN A CIRCLE — CUT ONE SEND TO'
  };
  /* THE FULL SENTENCE for a finding whose floor label had to be cut short (2026-09-23 playtest: the NOT FED nag
     ran wider than the room). The floor keeps the short label; the machine's HOVER CARD and the Workflow panel's
     hints carry this — a glance says what is wrong, the card says exactly how to fix it. */
  const VAL_WHY = {
    ORPHAN_BAY: 'This BAY isn’t on any line, so it only works when you message it directly. To add it to a line, drag from the machine that should hand it work onto this BAY — or pick BELT, click the machine that should hand it work, then this BAY (or click it and choose JOIN A LINE).',
    BAY_NOT_FED: 'Not fed — no belt brings work into this BAY. Run a belt INTO it: drag from the machine before it onto this BAY (or BELT: click that machine, then this BAY). If the lane passes a junction, it must run THROUGH the junction’s tile, not past its corner.',
    BAY_TOO_CLOSE: 'Too close — this BAY sits right beside the machine that feeds it, so the belt between them touches both at once and the job never arrives. Move one of them a tile further apart, then connect them again with BELT.',
    ORPHAN_JUNCTION: 'This junction touches no belt, so it routes nothing. Belt into it: drag from the machine before it onto this junction (or pick BELT, click that machine, then this junction), then on to the machines after it. A junction cannot be moved onto a belt that already joins two machines — to put one ON a line, delete this one and drop a junction from the hotbar onto that belt.',
    SPLIT_ONE_LANE: 'This SPLITTER needs two out-lanes — run belts THROUGH its tile: in on one side, out on two others.',
    JOIN_ONE_LANE: 'This JOINER needs two in-lanes — run a second belt INTO its tile.',
    LOOP_NO_DONE: 'This LOOP has no DONE lane — run a belt OUT of its tile onward (the first exit, in E/S/W/N order, is DONE unless you choose one).',
    LOOP_NO_BACK: 'This LOOP has no BACK lane — run a second belt OUT of its tile back to an earlier BAY.',
    LINE_TOO_LONG: 'Too long — the longest way through this line runs more stages than its LINE BUDGET allows, so a job that goes the longest way would stop part-way (the stages that ran are still paid for). Raise “max stages after the first” in this INBOX’s Workflow card › Optional limits · LINE BUDGET (24 at most), or shorten the line.',
    SEND_TO_MISSING: 'This OUTBOX sends to an INBOX that is gone or starts no line yet (or the OUTBOX itself ends no line), so nothing is sent on. Click the OUTBOX and pick a line under SEND TO (or NOWHERE).',
    SEND_TO_SELF: 'This OUTBOX sends its work back into its own line’s INBOX, so nothing is sent on. Click it and pick another line under SEND TO (or NOWHERE).',
    // (advice on the OUTBOX's card, never a floor nag — Pipeline.sendToFileAdvice says when it is true: final floor lane M19 / M29)
    SEND_TO_PRIVATE_FILES: 'This line has no project folder, so the files its crew makes stay in each agent’s private workspace. The finished text rides on, but the next line’s crew cannot open those files. Give this line a shared project folder (on its INBOX) to hand files on.',
    SEND_TO_LOOP: 'These lines send their work round in a circle, so every SEND TO on the circle is off — a job would never stop. Click one OUTBOX on the circle and set its SEND TO to NOWHERE or another line.'
  };
  const valWhy = code => VAL_WHY[code] || VAL_LABEL[code] || code;
  // a finding's full sentence for THIS machine — with its own numbers where the finding carries them (LINE_TOO_LONG)
  function findingWhy(e) {
    if (e && e.code === 'LINE_TOO_LONG' && e.stages > 0) {
      const fits = e.stages - 1 <= 24;
      return 'Too long — the longest way through this line runs ' + e.stages + ' stages, but its LINE BUDGET allows ' + (e.maxHops + 1) + ' (the first + ' + e.maxHops + ' more), so a job that goes that way would stop at stage ' + (e.maxHops + 2) + ' (the stages that ran are still paid for). '
        + (fits ? 'Raise “max stages after the first” to ' + (e.stages - 1) + ' in this INBOX’s Workflow card › Optional limits · LINE BUDGET, or shorten the line.' : 'No LINE BUDGET allows that many (25 stages at most): shorten the line.');
    }
    return VAL_WHY[e && e.code] || null;
  }
  const esc = s => U.esc(s == null ? '' : s);   // one complete impl (escapes & < > " ' — value="…" attrs here stay injection-safe)
  // THE ONE SENTENCE (2026-08-04 onramp): every self-introduction of the belt system leads with this.
  // It also leads the INBOX catalog desc (propsprites.js) and the first-run guide card — keep them aligned.

  // camera: screen = world*zoom + pan   (world = bake-pixel space, 1 tile = TILE px)
  let zoom = 2, panX = 0, panY = 0;
  const MINZ = 0.4, MAXZ = 6;

  // interaction state
  let tool = 'select', kind = 'hab', style = 'cobalt', mat = 'plate', hallWidth = 2, propType = 'war_intelcab', propCat = 'all', propTier = 'functional';
  let selectedPropId=null, positionOpen=false, groupIds=[];   // groupIds: a selection of two or more (MANY AT ONCE)
  let selBelts=null;   // THE HAND part 2: the belts a box (or a whole line) took with the selection — { key, links:[id], tiles:[{x,y}] } (see beltSel)
  let beltCardHot=null;   // the belt card's REMOVE key under the pointer / focus: { cells, ver } — the tiles only that connection rides, lit on the floor
  let selectedRoomId=null, furnishOpen=false, roomDelArmedAt=0, hoverHandle=-1;   // a selected ROOM (THE ROOM CARD); its hovered edge handle
  let roomAsk=null;   // a furnish / clear that would take equipment out, waiting on FURNISH ANYWAY (THE ROOM CARD)
  let propSection = 'decoration', propAbility = '', equipmentAgentId = '';
  let buildGroup = 'props';
  /* WHERE BUILD MODE OPENS (2026-09-27 audit F1/B5): WORK › AUTOMATE › WORKFLOWS opens it straight on the Conveyors tab (openWorkflows), and a
     Commander who was building a line last time comes back to the Conveyors tab instead of the furniture catalog. Only that
     tab is remembered: every other session still starts on Props, where the tutorial expects it. */
  let pendingGroup = null;
  const LAST_GROUP_KEY = 'starnet.refit.lastGroup';
  const readLastGroup = () => { try { return localStorage.getItem(LAST_GROUP_KEY) === 'workflow' ? 'workflow' : null; } catch (e) { return null; } };
  const writeLastGroup = g => { try { localStorage.setItem(LAST_GROUP_KEY, g === 'workflow' ? 'workflow' : 'props'); } catch (e) {} };
  const propShelfScroll = new Map();
  const BUILD_GROUPS = [
    ['props', 'Props', ['prop']], ['rooms', 'Rooms', ['room','hall']],
    ['surfaces', 'Surfaces', ['paint']], ['workflow', 'Conveyors', ['line','belt']],
    ['edit', 'Edit', ['select','dupe','reclaim']]   // (no MOVE: SELECT moves — drag a selected piece)
  ];
  let equipmentAccessKey = '', equipmentAccessView = null, equipmentAccessTicket = 0;
  let hoverThumb = null;
  // SURFACE targets one surface at a time — the deck or the walls — so the palette stays two rows
  // instead of four. 'follow' wall colour = inherit the room's floor hue (the default).
  let paintTarget = 'floor', wallMat = 'plating', wallStyle = 'follow';
  // the SHELL axis — a room's exterior, the surface you see from outside the station (WorldModel's
  // HULL_MATERIALS). 'follow' here means "the tone this material was drawn for", not "match the deck":
  // an exterior has no deck to match, and STATION's own follow-tone is the shell grey it always was.
  let hullMat = 'station', hullStyle = 'follow';
  let drag = null, hoverRoomId = null, hoverPropId = null, hoverTile = null, lastClient = { x: 0, y: 0 }, spaceHeld = false;
  /* THE CAPTURED POINTER (2026-08-07 conveyor audit). onDown setPointerCapture()s the canvas so a drag
     that leaves the element keeps tracking. Only onUp released it — every OTHER way a drag ends (ESC,
     right-click, pointercancel, window blur) dropped `drag` and left the capture ON, and a captured
     canvas swallows its own pointerleave/hover until the next click. Remember the id so every exit
     releases it; endDrag() is the ONE way a drag is dropped. */
  let dragPid = null;
  function releaseDrag() {
    if (dragPid != null && cv) { try { cv.releasePointerCapture(dragPid); } catch (e) {} }
    // a hand drag dropped any other way (Esc, right-click, pointercancel, blur) consumes R's corner flip like a release does (build-10)
    if (drag && (HAND_PLAN_MODES[drag.mode] || drag.handSeen) && flipPref) { flipPref = false; paintHandKeys(); }   // (handSeen: a belt drag that became a MOVE)
    dragPid = null; drag = null;
  }
  let dupe = null;   // DUPE tool clipboard: {type:'prop'|'room', rects (rel to top-left), …} — armed = ghost follows cursor, click stamps
  let lineType = 'research_line';   // LINES tool: the armed starter-line blueprint (WorldModel.BLUEPRINTS id)
  /* WHERE CAN THIS GO — the candidate field (2026-08-07). Arming a blueprint used to answer
     "where is this legal?" with nothing but a red ghost, so the only way to find a spot was to
     wave the pointer until the red went green. lineFields caches, PER BLUEPRINT, the full set of
     legal cursor tiles for the CURRENT floor; it is computed at most once per (blueprint, edit)
     and NEVER inside the frame loop's hot path (a full scan is ~thousands of checkBlueprint calls
     — per frame it would melt). station.onChange drops the whole map; that is the only invalidation. */
  const lineFields = Object.create(null);   // bpId -> { set:Set('tx,ty'), list:[{tx,ty}], runs:[…], edges:[…] }
  const lineFitsMemo = Object.create(null); // bpId -> bool, from the EARLY-EXIT probe (see lineFits)
  /* ---------- THE GEOMETRY VERSION: one explicit invalidation signal (2026-08-08 perf pass) ----------
     BUILD MODE's frame loop was re-deriving, at 60fps, a pile of answers that can only change when the
     FLOOR changes: the station bounds, the belt list, every bound bay's capability objects, the
     table-mount resolution for every prop, and the top readout's room/tile census. On a large deck
     that was the frame — bayObjects alone is O(bays × props × rooms).

     `geoVer` is bumped by exactly one thing: station.onChange (plus open(), so a second session can
     never read a memo left by the first). Every memo below stores the version it was computed at
     and recomputes the instant that number moves. A memo is NEVER refreshed on a timer, a guess or
     a heuristic — a stale overlay would be the app asserting a floor the model does not hold, which
     is the same lie the truthful-telemetry law forbids everywhere else. */
  let geoVer = 1;
  let boundsVer = 0, boundsMemo = null;
  let beltsVer = 0, beltsMemo = null;
  let bayObjVer = 0, bayObjMemo = null;    // Map agentId -> objects (bayObjects is pure over the doc)
  let mountVer = 0, mountOrder = null, mountMap = null;
  let statVer = 0;                          // top readout: the room/prop census only moves with the floor
  let jmapPlan = null, jmapOx = 0, jmapOy = 0, jmapMemo = null;   // junction map, keyed on the COMPILED plan
  function bumpGeo() {
    geoVer++;
    boundsMemo = null; beltsMemo = null; bayObjMemo = null; mountOrder = null; mountMap = null;
  }
  // the station bounds, once per edit. Callers READ it (never mutate), so one shared object is safe.
  const boundsMemoed = () => (boundsVer === geoVer && boundsMemo) ? boundsMemo : (boundsVer = geoVer, boundsMemo = station.bounds());
  /* station.belts() allocates a fresh array of {x,y,dir} — one split(',') per belt tile — on every
     call, and the frame called it once and handed it to three consumers. The model's belt graph
     cannot change without an onChange, and every consumer (conveyor.tick, conveyor.drawBelts, the
     ghost engine) treats it strictly read-only, so hand them all the SAME array for the edit. */
  const beltsMemoed = () => (beltsVer === geoVer && beltsMemo) ? beltsMemo : (beltsVer = geoVer, beltsMemo = station.belts());
  /* does this floor build by LINKS (conveyor-links phase B — every floor this build adopted)? Once per edit. On a linked
     floor a belt joins exactly the two machines it runs between, so the ring-rule advice (the spacing tip, "its belts
     stay behind") has nothing to say; it still speaks on a floor whose links were never adopted. */
  let linkedVer = 0, linkedMemo = false;
  const linkedFloor = () => (linkedVer === geoVer) ? linkedMemo : (linkedVer = geoVer, linkedMemo = !!(station && typeof station.isLinked === 'function' && station.isLinked()));
  /* bayObjects, per (agentId, geometry). Also DEFENSIVE: world.js has always wrapped this call in a
     try/catch and BUILD MODE called it bare, so one throw took out the whole validation layer (and with
     it every routing callout on the floor) instead of one bay's NO-COMPUTE check. */
  /* PER BAY (station.layout audit 2026-09-28): the router isolates a run's tools by the DOCK it runs at
     (router.stationFor(agentId, dockId) — a desk-less agent's second bay in another room gets THAT room), so a
     compute check keyed only by agent said "has a workstation" for a bay whose run had none. dockId optional. */
  function bayObjectsMemoed(agentId, dockId) {
    if (bayObjVer !== geoVer || !bayObjMemo) { bayObjVer = geoVer; bayObjMemo = new Map(); }
    const k = agentId + '|' + (dockId || '');
    if (bayObjMemo.has(k)) return bayObjMemo.get(k);
    let objs = [];
    try { objs = station.bayObjects(agentId, dockId) || []; } catch (_) { objs = []; }
    bayObjMemo.set(k, objs);
    return objs;
  }
  let convey = null, lastFrameTs = 0;   // editor conveyor sim (boxes flow live as you build)
  let ghost = null;                     // GHOST PROJECTION (Phase 3): dedicated engine — never mixes with convey
  let propThumbs = [], lastThumbTs = 0; // visual prop palette: live animated preview tiles + redraw throttle
  let propQuery = '';                   // palette SEARCH text: non-empty = browse the whole catalog flat, ignoring tier/cat

  const T = () => (station ? station.TILE : 12);
  const MAX_REFIT_CHUNKS = 18;

  /* ---------- lifecycle ---------- */
  function init(o) { opts = o; }

  function open() {
    makeResumed = false;   // a fresh BUILD MODE session picks up a made-prop job still running in the station
    makeMsg = null; if (makeJob && (makeJob.status === 'done' || makeJob.status === 'failed')) makeJob = null;   // and never greets with an old message
    makeCreditsAsked = false;   // and re-reads the credit state (the player may have just linked or topped up)
    if (running) return;
    station = opts.getStation();
    if (!station) return;
    spaceHeld = false; drag = null; dragPid = null; dupe = null; flashes.length = 0; touchPts.clear(); pinchLock=false; clearTimeout(inspectTimer); clickMachine=null; sendCutArm=null;   // never inherit latched state from a prior session
    // THE HAND's latches too (repair 2026-10-11): a reopened BUILD MODE never starts holding a piece, with REMOVE armed, a stale PICK
    // WHAT GOES HERE (its pin + ghost belt, a pick aimed at the last session's prop and tile), a box's belts, a flipped corner or Alt
    hand = null; touchArm = null; dropPick = null; selBelts = null; flipPref = false; altHeld = false; altLatched = false; floaters.length = 0; lastTap = null;
    // …nor a selection whose card the new dock never shows: SELECT MOVES would drag the old BAY instead of laying a belt, and Delete
    // would remove it (wave 2, build-18 — the same reset selectRoom / setSelection make)
    selectedPropId = null; groupIds = []; selectedRoomId = null; positionOpen = false; furnishOpen = false; roomDelArmedAt = 0;
    /* SESSION-SCOPED UI STATE (2026-08-07 conveyor audit). Everything here outlived close() and lied on the
       next open. The load-bearing one is `layerFailed`: renderDegraded is a TRUTHFUL-TELEMETRY readout —
       "a draw layer is currently failing" — and one transient throw in a session two hours ago had it
       asserting degradation forever, a state the harness could no longer prove. The rest are staleness:
       propCardKey made re-hovering the same prop after a reopen paint an EMPTY card (the key matched, so
       the body was never rebuilt), ordersSeenDone chimed completion for steps finished while BUILD MODE was
       shut, and propQuery reopened the palette silently filtered by a search the Commander can't see. */
    for (const k in layerFailed) delete layerFailed[k];
    propCardKey = null; ordersSeenDone = null; propQuery = ''; lastTier = '';
    propShelfScroll.clear();
    buildGroup = pendingGroup || readLastGroup() || 'props'; pendingGroup = null; propSection = 'decoration'; propAbility = ''; propCat = 'all'; propType = PropSprites.STARTER[0];
    equipmentAgentId = ''; equipmentAccessKey = ''; equipmentAccessView = null; equipmentAccessTicket++;
    tool = 'select';   // SELECT is the default mode — a fresh BUILD MODE session never opens with a placement tool armed
    escExitArmedAt = 0;   // a fresh session never inherits a half-pressed exit
    ridePending = false; rideAgentId = null; ridePrevReach = null;   // the auto first-ride re-arms (and re-baselines its reach snapshot) from THIS session's compile, never a stale one
    // finish-the-line: fresh session state (the registry itself persists in localStorage) + one seam probe
    wfHighlightId = null; wfPaused = null; wfHostMemo = null; wfKitAuto = false;
    finSample = null; finKeySel = null; finEngaged = false; finSig = ''; finCardEl = null; finComp = null; valComps = null; lastStampIds = null; finPollTs = 0; finSampleRes = null;
    for (const k in stampNameOf) delete stampNameOf[k];   // session-scoped blueprint-name placeholders (line naming)
    clearLineFields();   // a fresh session never inherits a prior floor's "where can this go" answers
    bumpGeo();           // …nor a prior floor's bounds/belts/bay-objects/mount memos (see geoVer)
    probeSampleSeam();
    buildDOM();
    if (opts.world && opts.world.stop) opts.world.stop();       // freeze the live sim
    document.body.classList.add('refit-on');
    updateSafetyClearance();
    unsub = station.onChange(p => {
      projectionDirty = true;
      planDirty = true;   // every edit refreshes navigation, routing and sprite state
      clearLineFields();   // …and so is every cached "where can this blueprint go" answer
      scheduleLineFitSync();   // …so the line cards on screen re-say NO ROOM / fits once the floor settles
      bumpGeo();           // …and every per-edit derived memo (bounds / belts / bayObjects / mounts / the readout census)
      /* A GLOBAL EDIT CANNOT BE INVALIDATED BY A RECTANGLE. The bake is cached in CHUNKS here, and
         `bakeDirtyRects` re-bakes only the chunks a rect touches — right for a deck or a prop, and
         WRONG for the shell, whose skin grouping and skirt ownership are station-wide. Drop the
         rect list entirely (null = re-bake everything) and latch it so a later rect-scoped edit in
         the same frame cannot re-narrow it. See the note on emit({global}) in worldmodel. */
      // ...and clear the pan-only flag, or a global edit arriving right after a pan would be
      // swallowed by `onlyMissingVisible` (which skips the dirty list entirely).
      if (!p || !p.staticBakeUnchanged || p.global) {
        bakeDirty = true; bakeVisibleOnly = false;
        if (p && p.global) bakeDirtyRectsGlobal = true;
        const rects = p && p.dirtyRects;
        bakeDirtyRects = bakeDirtyRects && rects ? bakeDirtyRects.concat(rects) : (rects || bakeDirtyRects);
        if (bakeDirtyRectsGlobal) bakeDirtyRects = null;
      }
      updateUndoRedo();
      renderSelection();
      if (tool === 'prop') renderEquipmentInfo();
    });
    const worldBake = opts.world && opts.world.refitBake && opts.world.refitBake(station);
    projectionDirty = false;
    cache = worldBake ? worldBake.cache : null;
    cacheGeo = worldBake ? worldBake.geo : null;
    bakeDirty = !worldBake; bakeDirtyRects = null; bakeDirtyRectsGlobal = false; bakeVisibleOnly = false; planDirty = true;
    frameFailures = 0;
    clearTimeout(frameRetryTimer); frameRetryTimer = 0;
    convey = (typeof Conveyor !== 'undefined') ? Conveyor.create({ onDeliver: onBuildDeliver, onAdvance: onBuildAdvance }) : null;
    ghost = (typeof GhostLine !== 'undefined') ? GhostLine.create() : null;   // Phase 3: fresh projection per session
    testNotes.length = 0;   // never carry a prior session's ride captions into a fresh BUILD MODE
    statSig = zoomSig = '';   // the top readout re-derives from THIS session's station, never a stale signature
    lastFrameTs = 0;
    resize();
    fitCamera();
    updateUndoRedo();
    // Help is available on demand; opening the editor starts with the library.
    running = true;
    if (typeof SFX !== 'undefined') SFX.open();
    raf = requestAnimationFrame(frame);
    /* the BUILD menu's own tooltip, armed under a pointer that did not move after the click, used to sit on the glass for the whole
       session: BUILD MODE opens OVER that button, so its pointerout never fires. The station tooltip hides on a scroll signal. */
    try { document.dispatchEvent(new Event('scroll')); } catch (_) {}
  }

  function close() {
    if (!running) return;
    running = false;
    connectFrom = null; connectTo = null;   // never carry a half-made connection across sessions
    deskOwner = null;
    if (raf) cancelAnimationFrame(raf), raf = 0;
    clearTimeout(frameRetryTimer); frameRetryTimer = 0;
    clearTimeout(tipTimer); tipTimer = 0;
    clearTimeout(rideTimer); rideTimer = 0; ridePending = false;   // a ride can't fire into a closed BUILD MODE
    if (convey) convey.reset(), convey = null;
    if (ghost) ghost.reset(), ghost = null;
    propThumbs.length = 0; lastThumbTs = 0;   // free the preview tiles' canvases
    if (unsub) unsub(), unsub = null;
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
    if (typeof WorkflowPanel !== 'undefined' && WorkflowPanel.isOpen()) WorkflowPanel.close();   // saves its open fields while the station is still ours
    wfHighlightId = null; wfPaused = null;
    finCardEl = null; finComp = null; finSig = '';   // the card's DOM dies with root below
    document.body.classList.remove('refit-on');
    document.body.style.removeProperty('--refit-dock-clearance');
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = cv = ctx = tip = hintEl = undoBtn = redoBtn = null;
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    if (typeof SFX !== 'undefined') SFX.close();
    // BUILD MODE HANDS ITS FLOOR BACK: when nothing is left to bake, its chunks stitched into one whole-station bake become
    // the live world's (World rebake / StationBake.stitchWhole), instead of the world re-baking the station it just left
    if (opts.world && opts.world.adoptBuildBake && StationBake.stitchWhole && station && cache && cache.chunked && !bakeDirty) {
      let whole = null;
      try { whole = StationBake.stitchWhole(station.projectGeometry(), cache); }
      catch (e) { console.warn('[refit] could not hand the floor back to the world; it re-bakes the station instead', e); }
      if (whole) opts.world.adoptBuildBake(station, whole);
    }
    // the chunks (and their dense plates) are not drawn again until the next open() takes the world's bake: free them now
    cache = null; cacheGeo = null; bakeDirty = true;
    const saved = opts.persist ? opts.persist() : false;
    if (saved && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('Station layout saved locally', 'good', undefined, { transient: true });
    if (opts.world && opts.world.refit) opts.world.refit();     // recenter the live world on the new build
    if (opts.world && opts.world.start) opts.world.start();     // resume the live sim with the new build
    if (opts.onClose) opts.onClose();
  }

  const toggle = () => (running ? close() : open());
  const isOpen = () => running;

  /* ---------- DOM ---------- */
  function buildDOM() {
    root = document.createElement('div');
    root.className = 'refit-overlay';
    root.innerHTML = `
      <canvas class="refit-canvas"></canvas>
      <div class="refit-top">
        <span class="refit-title">BUILD MODE</span>
        <span class="refit-sub" id="refit-sub"></span>
        <span class="refit-spacer"></span>
        <span class="refit-zoom" id="refit-zoom">
          <button class="bb sm refit-zoomb" id="refit-zout" title="zoom out (or scroll the wheel)">–</button>
          <button class="bb sm refit-zoomlvl" id="refit-zlvl" title="reset zoom to 1 tile = 1 tile">100%</button>
          <button class="bb sm refit-zoomb" id="refit-zin" title="zoom in (or scroll the wheel)">+</button>
        </span>
        <span class="refit-cluster" id="refit-history">
          <button class="bb sm" id="refit-undo" title="undo (Ctrl+Z)">↶ UNDO</button>
          <button class="bb sm" id="refit-redo" title="redo (Ctrl+Shift+Z)">↷ REDO</button>
        </span>
        <button class="bb sm" id="refit-fit" title="frame the station">⊹ FIT</button>
        <button class="bb sm" id="refit-test" data-tip="Test this line: WATCH IT is free (a crate rides the belts, no agent runs); STEP THROUGH and SEND A REAL JOB run it for real.">${esc(PREVIEW_LABEL)}</button>
        <button class="bb sm" id="refit-help" title="how to build">? HELP</button>
        <button class="bb sm refit-primary" id="refit-done" title="finish + save (or press Esc twice)">SAVE & EXIT</button>
      </div>
      <div class="refit-dock" role="region" aria-label="Construction kit">
        <div class="refit-dock-head"><span class="refit-dock-head-t">BUILD LIBRARY</span><button class="bb refit-presets-entry" id="refit-stations" type="button">▦ Presets</button><button class="bb sm" type="button" id="refit-kit-toggle" aria-expanded="true" aria-controls="refit-option-section">MINIMIZE ▴</button></div>
        <nav class="refit-library-tabs" aria-label="Build categories"></nav>
        <div class="refit-dock-section refit-mode-section">
          <div id="refit-tools"></div>
        </div>
        <section id="refit-selection" class="refit-selection" aria-label="Selected object" hidden></section>
        <div class="refit-dock-section refit-option-section" id="refit-option-section">
          <div class="refit-section-label" id="refit-palette-label">OPTIONS</div>
          <div class="refit-palette" id="refit-palette"></div>
        </div>
        <div class="refit-tool-help" id="refit-tool-help"><span></span><button class="bb sm" type="button" id="refit-stop">STOP PLACING</button></div>
        <div class="refit-hint" id="refit-hint"></div>
      </div>
      <div class="refit-tip" id="refit-tip"></div>
      <div class="refit-propcard" id="refit-propcard" role="tooltip"></div>`;
    document.body.appendChild(root);
    cv = root.querySelector('.refit-canvas');
    ctx = cv.getContext('2d');
    tip = root.querySelector('#refit-tip');
    propCard = root.querySelector('#refit-propcard');
    hintEl = root.querySelector('#refit-hint');
    undoBtn = root.querySelector('#refit-undo');
    redoBtn = root.querySelector('#refit-redo');

    const tools = root.querySelector('#refit-tools');
    const toolBtn = (t) => {
      const btn = document.createElement('button');
      btn.className = 'bb refit-tool refit-tool-' + t.id + (t.id === tool ? ' active' : '');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', t.id === tool ? 'true' : 'false');
      btn.dataset.tool = t.id;
      const ico = document.createElement('canvas');
      ico.className = 'refit-toolicon';
      // 8× supersample: every icon pixel lands on an exact 8px block in the backing store, so the
      // browser's downscale to the 16px display box is a clean box filter. Painting at ~1.3 device
      // px per icon pixel instead (with image-rendering:pixelated) doubles some rows and not others
      // — the bitmap comes out visibly lopsided, which is exactly what these icons are replacing.
      ico.width = ico.height = ICON_N * 8;
      btn.appendChild(ico);
      const nm = document.createElement('span'); nm.className = 'refit-toolname'; nm.textContent = t.label;
      btn.appendChild(nm);
      /* the Conveyors tab's HOTBAR owns 1–8 while that tab is up (repair 2026-10-11): a tool shown only there (BELT) never wears a
         number that, pressed there, picks a hotbar piece instead (7 = FILTER) — its badge and tip carry no key */
      const shadowed = /^[1-8]$/.test(t.key) && BUILD_GROUPS.some(g => g[0] === 'workflow' && g[2].includes(t.id)) && !BUILD_GROUPS.some(g => g[0] !== 'workflow' && g[2].includes(t.id));
      if (!shadowed) { const k = document.createElement('span'); k.className = 'refit-key'; k.textContent = t.key; btn.appendChild(k); }
      btn.title = t.hint + (shadowed ? '' : '  (' + t.key + ')');
      // clicking the ARMED tool's own button again DESELECTS it (back to select) — a tool must
      // always have an obvious off switch, not just eight other on switches.
      btn.onclick = () => selectTool(t.id === 'line' || t.id === tool ? 'select' : t.id);
      return btn;
    };
    const byId = id => TOOLS.find(x => x.id === id);
    // Browse by intent. Only the current category's tools occupy the shelf.
    const tabs = root.querySelector('.refit-library-tabs');
    for (const [id,name,ids] of BUILD_GROUPS) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bb';
      b.dataset.buildGroup = id; b.textContent = name;
      b.onclick = () => { if (buildGroup === id) return; buildGroup = id; writeLastGroup(id); selectTool('select'); };
      tabs.appendChild(b);
    }
    tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', 'Build tools');
    for (const [id,name,ids] of BUILD_GROUPS) {
      const group = document.createElement('section'); group.className = 'refit-toolset'; group.dataset.group = id; group.setAttribute('aria-label',name);
      const caption = document.createElement('div'); caption.className = 'refit-toolset-label'; caption.textContent = name;
      const buttons = document.createElement('div'); buttons.className = 'refit-toolset-buttons' + (ids[0] === 'select' ? ' is-edit' : '');
      ids.forEach(id => buttons.appendChild(toolBtn(byId(id)))); group.append(caption,buttons); tools.appendChild(group);
    }
    // Dismissing the category picker on the deck must not stamp a prop underneath it.
    root.addEventListener('pointerdown', ev => {
      const menu = root.querySelector('.refit-category-menu[open]');
      if (!menu || menu.contains(ev.target)) return;
      menu.open = false;
      if (ev.target === cv) { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
    root.querySelector('#refit-kit-toggle').onclick = () => toggleKit();
    root.querySelector('#refit-stop').onclick = () => selectTool('select');
    renderPalette();
    repaintIcons();
    setCursor();

    root.querySelector('#refit-done').onclick = close;
    root.querySelector('#refit-help').onclick = showGuide;
    root.querySelector('#refit-fit').onclick = () => { fitCamera(); };
    root.querySelector('#refit-stations').onclick = showStationBuilds;
    root.querySelector('#refit-zin').onclick = () => zoomStep(+1);
    root.querySelector('#refit-zout').onclick = () => zoomStep(-1);
    root.querySelector('#refit-zlvl').onclick = () => zoomTo(2);   // 2 = the entering default (a tile reads at 24px)
    root.querySelector('#refit-test').onclick = (e) => openTest(e);
    undoBtn.onclick = () => { dropPickOff(); const r = station.undo(); sfx(r.ok ? 'click' : 'bad'); floatHistory(r, 'UNDID'); };
    redoBtn.onclick = () => { dropPickOff(); const r = station.redo(); sfx(r.ok ? 'click' : 'bad'); floatHistory(r, 'REDID'); };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('dblclick', onDblClick);   // THE HAND part 2: a double-click on a conveyor piece takes its whole line
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointerleave', () => { hoverRoomId = null; hoverPropId = null; hoverTile = null; if (!drag) hideTip(); hidePropCard(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    try { ro = new ResizeObserver(() => { resize(); }); ro.observe(cv); } catch (e) {}
    setHint();
  }

  /* ---------- prop palette taxonomy ----------
     Props are split into two TIERS (functional vs cosmetic) carried on each CATALOG entry, then grouped by
     `cat` within the tier. This is the "clean area for the stuff that actually does something" split. */
  const TIER_ORDER = ['functional', 'cosmetic'];
  // The tier/category DISPLAY names now live with the catalog they describe (PropSprites), because the
  // palette is no longer their only reader — propsearch.js matches against them so typing what the tab
  // SAYS finds what the tab shows. Copying them here again is how the tab and the search drift apart.
  // Read LAZILY, not snapshotted into a const at IIFE-load time: this file is a plain <script> and a
  // const would freeze whatever PropSprites happened to be when build.js parsed. index.html loads
  // propsprites.js first today, but a silently-empty label map is a miserable way to find that out.
  const TIER_LABEL = () => (typeof PropSprites !== 'undefined' && PropSprites.TIER_LABEL) || {};
  const CAT_LABEL = () => (typeof PropSprites !== 'undefined' && PropSprites.CAT_LABEL) || {};
  // the agent-assignable workstation types — the 'computer' props the agent walks to + sits at (matches
  // world.js isWorkstationProp / deskPropFor seating + the CATALOG seat:true set). These open the picker on place/click.
  const WORKSTATION_TYPES = { desk: 1, desk2: 1, console: 1, consoleL: 1, pixelrig: 1, bench: 1 };
  const catalog = () => (typeof PropSprites !== 'undefined') ? PropSprites.CATALOG : [];
  // the ordered list of category ids that belong to a tier (first-appearance order in the catalog)
  function catsForTier(tier) {
    const out = [], seen = {};
    for (const c of catalog()) { if ((c.tier || 'cosmetic') !== tier) continue; if (!seen[c.cat]) { seen[c.cat] = 1; out.push(c.cat); } }
    return out;
  }
  const agentLabel = aid => {
    const list = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const a = list.find(x => x.id === aid);
    return a ? (a.name || a.id) : aid;
  };

  /* ---------- palette SEARCH (the flat way into a 120-prop catalog) ----------
     PropSearch owns the matching rules and is unit-tested against the real catalog; everything here is
     presentation. Two things are load-bearing and easy to get wrong:
       1. a keystroke rebuilds the GALLERY ONLY — never the row holding the <input>, or focus dies;
       2. while a search is up the tier/cat rows are HIDDEN, not just ignored. A lit "LOUNGE" tab above a
          grid of workstations is the UI asserting something false about what you're looking at. */
  const catLabelOf = c => CAT_LABEL()[c] || String(c || '').toUpperCase();
  const tierLabelOf = t => TIER_LABEL()[t] || String(t || '').toUpperCase();
  // the power word printed on the tile's badge (COMPUTE / WEB / FILES / …), or '' for inert decor.
  // It is on screen, so it has to be typeable — the prop -> capability map lives in the world model.
  const grantLabelOf = c => ((typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp)
    ? (WorldModel.grantLabelForProp(c && c.id) || '') : '');
  const capOf = c => WorldModel.capForProp(c.id);
  const sectionOf = c => EquipmentHelp.kind(c, capOf(c));
  const SECTION_NAMES = { decoration: 'FURNITURE', equipment: 'EQUIPMENT', abilities: 'ABILITIES' };
  const starterProps = () => PropSprites.STARTER.map(id => PropSprites.spec(id)).filter(Boolean);
  const abilityName = cap => EquipmentHelp.ABILITY_NAMES[cap] || String(cap || '').toUpperCase();
  const chooseLibrarySection = section => {
    if (section === propSection) return;
    propSection = section; propAbility = ''; propCat = 'all'; propQuery = '';
    // Browsing another shelf must not silently arm its first item.
    selectTool('select');
  };
  function chooseAbility(cap, designs = false) {
    const c = starterProps().find(p => capOf(p) === cap) || catalog().find(p => capOf(p) === cap);
    if (!c) return;
    propSection = 'abilities'; propAbility = designs ? cap : ''; propCat = 'all'; propQuery = '';
    // Keep a selected alternate design when opening its family.
    if (WorldModel.capForProp(propType) !== cap) propType = c.id;
    hidePropCard(); renderPalette(); setHint(); sfx('click');
  }
  // one options bundle so the palette and the unit test match on IDENTICAL surfaces
  const searchOpts = () => ({ catLabel: catLabelOf, tierLabel: tierLabelOf, extra: c => [grantLabelOf(c), EquipmentHelp.label(c, capOf(c)), EquipmentHelp.PURPOSE[capOf(c)] || ''].join(' ') });
  const isSearching = () => (typeof PropSearch !== 'undefined') && PropSearch.active(propQuery);

  // what the gallery is showing right now: matches across the WHOLE catalog, or the chosen tab
  // Props the STATION places for you (a plugin's terminal appears when an approved plugin brings tools) are never
  // offered in the picker: a Commander placing one by hand would get a terminal bound to nothing.
  const STATION_PLACED = new Set(['plugin_terminal']);
  const pickable = (list) => list.filter(c => !STATION_PLACED.has(c.id));
  function propsForGrid() {
    if (isSearching()) return pickable(PropSearch.matchProps(catalog(), propQuery, searchOpts()));
    if (propSection === 'abilities') return pickable(propAbility
      ? catalog().filter(c => capOf(c) === propAbility) : starterProps());
    const list = pickable(catalog().filter(c => sectionOf(c) === propSection && (propCat === 'all' || c.cat === propCat)));
    if (propSection === 'decoration' && propCat === 'all') {
      const familiar = ['couch','industrial_roundtable','dinerchair','plant','rug','tv','bookshelf','coffee','bunk','easel'];
      const rank = c => { const i = familiar.indexOf(c.id); return i < 0 ? familiar.length : i; };
      list.sort((a,b) => rank(a) - rank(b));
    }
    return list;
  }

  /* Leave search mode and go back to browsing. This must rebuild the WHOLE palette, not just the
     gallery: picking a prop out of a search result moves propTier/propCat to that prop's own drawer,
     so the tier and category buttons carry stale `active` classes until they are re-created. Clearing
     with only a grid re-render is what left the palette showing WORKSTATIONS with nothing lit while a
     beanbag was the armed prop. Re-focus the field afterwards — the caller is still typing. */
  function clearSearch({ refocus = true } = {}) {
    propQuery = '';
    selectTool('select', {silent:true});
    if (!refocus) return;
    const f = root && root.querySelector('#refit-propsearch-input');
    if (f) f.focus();
  }

  /* MAKE A PROP (player-made props, userprops.js): type any object, StarNet draws it in the station's style on
     StarNet credits, and it joins the catalog under MADE BY YOU as decoration. The status line reads ONLY the job
     state the station reports (step, try n of 3, the cost the cloud actually billed); the job keeps running in
     the station if BUILD MODE closes, and this panel picks it back up on reopen. */
  let makeJob = null, makeMsg = null, makeWatching = '';
  let makeBusy = false;      // a paid start (preview, make, side view) is in flight: one at a time, from every door (button, Enter, kit)
  let makeDraft = '', makeFocused = false;   // what is typed survives a palette redraw (a job landing, a chip click)
  const MAKE_PRICE = 0.35;
  const MAKE_STEP = { queued: 'Queued', waiting: 'Working', starting: 'Starting', saving: 'Saving it to the station', sizing: 'Sizing it against the catalog', drawing: 'Drawing', retrying: 'Redrawing', checking: 'Checking it matches the station' };
  function makeStatusText() {
    if (makeMsg) return makeMsg;
    if (!makeJob) {
      const bal = makeCredits && makeCredits.linked ? makeCredits.balanceUsd : null;
      if (bal != null && bal > 0 && bal < MAKE_PRICE) return { text: 'StarNet credits \u00b7 $' + bal.toFixed(2) + ' left \u00b7 not enough to make a prop (about $0.35)', tone: 'bad', door: true };
      return { text: (bal != null && bal > 0 ? 'StarNet credits \u00b7 $' + bal.toFixed(2) + ' left' : 'StarNet credits') + ' \u00b7 preview first (about 5\u00a2), then make it (about $0.35; a side view about $0.30)', tone: '' };
    }
    const j = makeJob, spent = j.costUsd > 0 ? ' \u00b7 $' + j.costUsd.toFixed(2) + ' so far' : '';
    if (j.status === 'done' && j.kind === 'side') return { text: 'Side view made \u00b7 cost $' + (Number(j.costUsd) || 0).toFixed(2) + (j.costPending ? ' (final cost settling)' : '') + ' \u00b7 press R to turn it', tone: 'ok' };
    if (j.status === 'done') return { text: 'Made ' + (j.label || j.noun) + ' \u00b7 cost $' + (Number(j.costUsd) || 0).toFixed(2) + (j.costPending ? ' (final cost settling \u00b7 see credit history)' : '') + (j.placeHint ? ' \u00b7 place it from FURNITURE \u25b8 MADE BY YOU' : ' \u00b7 in MADE BY YOU'), tone: 'ok' };
    if (j.status === 'failed') return { text: ((j.error && j.error.message) || 'That prop could not be made.') + (j.costUsd > 0 ? ' Spent $' + j.costUsd.toFixed(2) + '.' : ''), tone: 'bad' };
    const step = MAKE_STEP[j.step] || 'Working';
    const tries = (j.step === 'drawing' || j.step === 'retrying' || j.step === 'checking') && j.tries ? ' (try ' + j.tries + ' of ' + (j.maxTries || 3) + ')' : '';
    return { text: step + tries + '\u2026' + spent, tone: 'busy' };
  }
  function paintMakeStatus() {
    const el = root && root.querySelector('#refit-makeprop-status');
    if (!el) return;
    const st = makeStatusText();
    el.textContent = st.text; el.className = 'refit-makeprop-status' + (st.tone ? ' ' + st.tone : '');
    // the compact row opens when there is something the Commander must see (a running or resumed job, a preview, a
    // message, a draft): the mount decided before these could arrive
    const panel = el.closest('.refit-makeprop');
    if (panel && panel.classList.contains('is-compact') && (makeBusy || makeMsg || makePreview || (makeDraft && makeDraft.trim()) || (makeJob && makeJob.status !== 'done' && makeJob.status !== 'failed'))) {
      panel.classList.remove('is-compact');
      const head = panel.querySelector('.refit-makeprop-head');
      if (head) head.setAttribute('aria-expanded', 'true');
    }
    const door = root.querySelector('#refit-makeprop-door');
    const cta = root.querySelector('#refit-makeprop-cta');
    // TOP UP only for a balance the service REPORTED at <= 0: an unknown balance (a failed check) is not an empty wallet
    const need = !makeCredits ? '' : !makeCredits.linked ? (makeCredits.linkable ? 'link' : '') : (makeCredits.balanceUsd != null && !(makeCredits.balanceUsd > 0)) ? 'topup' : '';
    if (cta) {
      cta.hidden = !need;
      if (need) {
        cta.querySelector('span').textContent = need === 'link' ? 'Props are made with StarNet credits: about 5\u00a2 to preview, 35\u00a2 to make.' : 'You\u2019re out of StarNet credits. A prop is about 35\u00a2.';
        cta.querySelector('button').textContent = need === 'link' ? 'GET STARNET CREDITS' : 'TOP UP CREDITS';
      }
    }
    if (door) door.hidden = !!need || !((makeMsg && makeMsg.door) || (!makeMsg && st.door));   // the card above already carries the door
    const busy = makeBusy || !!(makeJob && makeJob.status !== 'done' && makeJob.status !== 'failed');
    const go = root.querySelector('#refit-makeprop-go');
    if (go) go.disabled = busy;
    root.querySelectorAll('#refit-makeprop-preview button').forEach((b) => { if (b.id !== 'refit-makeprop-drop') b.disabled = busy; });
    // MAKE SIDE VIEW: offered only for a selected made prop that has no side view yet
    const size = root.querySelector('#refit-makeprop-size');
    if (size) {
      const mine = typeof UserProps !== 'undefined' && UserProps.get ? UserProps.get(propType) : null;
      size.hidden = !mine;
      if (mine) {
        const k = UserProps.SCALES.includes(mine.scale) ? mine.scale : 1;
        size.querySelector('.refit-makeprop-sizeval').textContent = Math.round(k * 100) + '%';
        size.querySelector('[data-size="-1"]').setAttribute('aria-label', 'Make ' + (mine.label || 'this prop') + ' smaller, now ' + Math.round(k * 100) + '%');
        size.querySelector('[data-size="1"]').setAttribute('aria-label', 'Make ' + (mine.label || 'this prop') + ' bigger, now ' + Math.round(k * 100) + '%');
        size.querySelector('[data-size="-1"]').disabled = busy || k === UserProps.SCALES[0];
        size.querySelector('[data-size="1"]').disabled = busy || k === UserProps.SCALES[UserProps.SCALES.length - 1];
      }
    }
    const del = root.querySelector('#refit-makeprop-del');
    if (del) {
      const mine = typeof UserProps !== 'undefined' && UserProps.get ? UserProps.get(propType) : null;
      del.hidden = !mine; del.disabled = busy;
    }
    const side = root.querySelector('#refit-makeprop-side');
    if (side) {
      const made = typeof UserProps !== 'undefined' && UserProps.get ? UserProps.get(propType) : null;
      side.hidden = !(made && !made.side && !made.symmetric);   // a round prop already turns with its own art
      side.disabled = busy;
      side.textContent = made ? '\u21bb MAKE SIDE VIEW \u00b7 ' + (made.label || 'this prop') : '\u21bb MAKE SIDE VIEW';
    }
  }
  async function startMakeSide(targetId) {
    const made = typeof UserProps !== 'undefined' && UserProps.get ? UserProps.get(targetId || propType) : null;
    if (!made || made.side || makeBusy || (makeJob && makeJob.status !== 'done' && makeJob.status !== 'failed')) return null;
    makeBusy = true;
    makeMsg = { text: 'Starting the side view\u2026', tone: 'busy' }; paintMakeStatus();
    let r;
    try { r = await UserProps.makeSide(made.id); } finally { makeBusy = false; }
    if (r && r.ok && r.job) { watchMakeJob(r.job); return r; }
    makeJob = null;
    makeMsg = { text: (r && r.message) || 'That side view could not be started.', tone: r && r.code === 'unreachable' ? '' : 'bad', door: r && (r.code === 'not_linked' || r.code === 'insufficient_credits') };
    paintMakeStatus();
    return r;
  }
  function watchMakeJob(job) {
    makeJob = job; makeMsg = null;
    if (makeWatching === job.id || typeof UserProps === 'undefined') { paintMakeStatus(); return; }
    makeWatching = job.id;
    paintMakeStatus();
    UserProps.watch(job.id, (j) => { makeJob = j; paintMakeStatus(); }).then((j) => {
      makeWatching = '';
      makeJob = j;
      makeCreditsAsked = false; loadMakeCredits();   // the balance moved: show the real one, and the top-up card if it hit zero
      if (j.status === 'done' && j.kind === 'side') { if (root) { renderPalette(); renderSelection(); } }
      else if (j.status === 'done' && j.propId && typeof PropSprites !== 'undefined' && PropSprites.spec(j.propId)) {
        makeJob.label = PropSprites.spec(j.propId).label;
        // arm it only where the player still is (FURNITURE shelf, props tools); elsewhere say where it went
        const onShelf = buildGroup === 'props' && propSection === 'decoration' && (tool === 'prop' || tool === 'select');
        if (onShelf) {
          propType = j.propId; propCat = 'yours'; propQuery = '';
          if (root) { setLibraryPlacement(true); renderPalette(); }
        } else {
          makeJob = { ...makeJob, placeHint: true };
          if (root) { renderPalette(); renderSelection(); setHint('Made ' + (makeJob.label || makeJob.noun) + ' \u00b7 place it from FURNITURE \u25b8 MADE BY YOU'); }
        }
      } else if (root) renderSelection();
      paintMakeStatus();
      sfx(j.status === 'done' ? 'confirm' : 'click');
    });
  }
  // PREVIEW before paying: a few-cent sketch + the size it will be, then MAKE IT (the real drawing reuses that sizing
  // and draws from the approved sketch) or ANOTHER. The card says plainly the sketch is not the final art.
  // drawn height -> real height: 12px per metre (the crew's 1.75 m is 22px), less the ~3px visible top band
  const previewMetres = (h) => { const m = Math.max(0.5, Math.round(((Number(h) || 0) - 3) / 12 * 2) / 2); return m + ' m'; };
  let makePreview = null;   // { id, noun, preview:{label, footprint, height, like, symmetric, sketch}, costUsd } | null
  function paintPreviewCard() {
    const card = root && root.querySelector('#refit-makeprop-preview');
    if (!card) return;
    if (!makePreview || !makePreview.preview) { card.hidden = true; card.replaceChildren(); return; }
    const p = makePreview.preview, fp = String(p.footprint || '').split('x');
    card.hidden = false;
    card.innerHTML = '<img alt="Preview sketch of ' + esc(p.label || makePreview.noun) + '" src="' + esc(p.sketch) + '">' +
      '<div class="refit-makeprop-previewtxt"><b>' + esc(p.label || makePreview.noun) + '</b>' +
      '<span>About ' + esc(fp[0] || '?') + '\u00d7' + esc(fp[1] || '?') + ' tiles, ' + previewMetres(p.height) + ' tall' + (p.profile ? ' \u00b7 shown side-on' : '') + (p.symmetric ? ' \u00b7 turns freely' : '') + '</span>' +
      '<small>Quick preview. The final is drawn in full detail from this, so small details can differ. ' + (makePreview.costPending ? 'Preview cost settling (see credit history).' : 'Preview cost $' + (Number(makePreview.costUsd) || 0).toFixed(2) + '.') + '</small>' +
      '<div class="refit-makeprop-previewbtns"><button type="button" class="bb sm" id="refit-makeprop-makeit">MAKE IT \u00b7 ~$0.35</button><button type="button" class="bb sm" id="refit-makeprop-again">ANOTHER \u00b7 ~5\u00a2</button><button type="button" class="bb sm" id="refit-makeprop-drop" aria-label="Discard preview">\u2715</button></div></div>';
    // the paid preview stays until MAKE IT really started (out of credit, busy, offline: it is still there to use)
    card.querySelector('#refit-makeprop-makeit').onclick = async () => { const pv = makePreview; sfx('click'); if (await startMakeProp(pv.noun, pv.id) && makePreview === pv) { makePreview = null; paintPreviewCard(); } focusMakeInput(); };
    card.querySelector('#refit-makeprop-again').onclick = () => { sfx('click'); startPreviewProp(makePreview.noun).then(focusMakeInput); };
    card.querySelector('#refit-makeprop-drop').onclick = () => { makePreview = null; makeMsg = null; paintPreviewCard(); paintMakeStatus(); sfx('click'); focusMakeInput(); };
  }
  function focusMakeInput() {
    const inp = root && root.querySelector('#refit-makeprop-input');
    if (inp) { try { inp.focus({ preventScroll: true }); } catch (_) { inp.focus(); } }
  }
  async function startPreviewProp(noun) {
    noun = String(noun || '').trim();
    if (typeof UserProps === 'undefined') return;
    if (!noun) { makeMsg = { text: 'Type an object first, like \u201ca grandfather clock\u201d.', tone: 'bad' }; paintMakeStatus(); focusMakeInput(); return; }
    if (makeBusy || (makeJob && makeJob.status !== 'done' && makeJob.status !== 'failed')) return;   // Enter can't sneak past the lock
    makeBusy = true;
    makeJob = null; makeMsg = { text: 'Previewing\u2026', tone: 'busy' }; paintMakeStatus();
    let r, res;
    try {
      r = await UserProps.startPreview(noun);
      if (r && r.ok && r.job) {
        const PSTEP = { queued: 'Queued', sizing: 'Sizing it against the catalog', sketching: 'Sketching a preview', checking: 'Checking the preview' };
        res = await UserProps.watchPreview(r.job.id, (j) => { makeMsg = { text: (PSTEP[j.step] || 'Previewing') + '\u2026', tone: 'busy' }; paintMakeStatus(); });
      }
    } finally { makeBusy = false; }
    makeCreditsAsked = false; loadMakeCredits();
    if (!r || !r.ok || !r.job) {
      makeMsg = { text: (r && r.message) || 'That preview could not be started.', tone: 'bad', door: r && (r.code === 'not_linked' || r.code === 'insufficient_credits') };
      paintMakeStatus(); paintPreviewCard(); return;
    }
    if (res && res.ok && res.preview) {
      makePreview = { id: r.job.id, noun, preview: res.preview, costUsd: res.job && res.job.costUsd, costPending: !!(res.job && res.job.costPending) };
      makeMsg = { text: 'Preview ready \u00b7 make it, or try another', tone: 'ok' };
    } else {
      makeMsg = { text: ((res && res.job && res.job.error && res.job.error.message) || (res && res.message) || 'That preview could not be made.') + (res && res.job && res.job.costUsd > 0 ? ' Spent $' + res.job.costUsd.toFixed(2) + '.' : ''), tone: 'bad' };
    }
    paintPreviewCard(); paintMakeStatus();
  }
  async function startMakeProp(noun, previewId) {
    noun = String(noun || '').trim();
    if (!noun || typeof UserProps === 'undefined' || makeBusy || (makeJob && makeJob.status !== 'done' && makeJob.status !== 'failed')) return false;
    makeBusy = true;
    makeMsg = { text: 'Starting\u2026', tone: 'busy' }; paintMakeStatus();
    let r;
    try { r = await UserProps.generate(noun, previewId); } finally { makeBusy = false; }
    if (r && r.ok && r.job) { watchMakeJob(r.job); return true; }
    const code = r && r.code;
    makeJob = null;
    makeMsg = { text: (r && r.message) || 'That prop could not be started.', tone: code === 'unreachable' ? '' : 'bad', door: code === 'not_linked' || code === 'insufficient_credits' };
    paintMakeStatus();
    return false;
  }
  // BUILD MODE reopened while the station still has a job in flight: pick it back up instead of forgetting it.
  let makeResumed = false;   // once per BUILD MODE open: a render must not refetch (and race) the made-prop list
  let makeCredits = null, makeCreditsAsked = false;   // { linked, balanceUsd } from /api/credits; null = not known (show nothing)
  function loadMakeCredits() {
    if (makeCreditsAsked || typeof Harness === 'undefined' || !Harness.api) return;
    makeCreditsAsked = true;
    Harness.api.get('/api/credits?history=0').then((j) => {
      // a failed balance check answers balanceUsd:null: keep it unknown, never a $0 that tells a funded user to top up
      if (j && typeof j.configured === 'boolean') makeCredits = { linked: j.configured, balanceUsd: typeof j.balanceUsd === 'number' && isFinite(j.balanceUsd) ? j.balanceUsd : null };
    }, (e) => {   // /api/credits 404s by design when no account is linked: a definitive "not linked"
      if (/http 404\b/.test(String((e && e.message) || e))) makeCredits = { linked: false, balanceUsd: 0 };
    }).then(() => {
      if (!makeCredits || makeCredits.linked) return null;
      // never offer an account this build cannot create: the door shows only when linking is possible
      return Harness.api.get('/api/credits/linkable').then((j) => { makeCredits.linkable = !!(j && j.available); }, () => { makeCredits.linkable = false; });
    }).then(() => paintMakeStatus());
  }
  function openCreditsDoor() {
    const door = typeof Friendly !== 'undefined' && Friendly.actionButton && Friendly.actionButton({ action: 'store' });
    if (!door || !door.run) return;
    door.run();
    // land ON the StarNet card (PROVIDERS opens at the top of a long list); it renders after its own credits read
    let tries = 0;
    const seek = () => {
      const card = document.querySelector('.prov-card[data-provider="starnet"]');
      if (card && card.offsetParent) { try { card.scrollIntoView({ block: 'center' }); } catch (_) {} return; }
      if (++tries < 12) setTimeout(seek, 250);
    };
    setTimeout(seek, 150);
  }
  function resumeMakeJob() {
    loadMakeCredits();
    if (makeResumed || makeJob || makeWatching || typeof UserProps === 'undefined') return;
    makeResumed = true;
    UserProps.load().then((r) => {
      const j = r && r.jobs && r.jobs[0];
      if (j && !makeJob) watchMakeJob(j);
      else if (!makeJob && !makeMsg && r && Array.isArray(r.recent)) {
        let seen = [];
        try { seen = JSON.parse(localStorage.getItem('starnet.userprops.seen') || '[]'); } catch (_) { seen = []; }
        const miss = r.recent.find((x) => x && x.status === 'failed' && !seen.includes(x.id));
        if (miss) {
          makeMsg = { text: 'While BUILD MODE was closed: ' + (miss.noun || 'a prop') + ' \u2014 ' + ((miss.error && miss.error.message) || 'it could not be made.'), tone: 'bad' };
          try { localStorage.setItem('starnet.userprops.seen', JSON.stringify(seen.concat(r.recent.map((x) => x.id)).slice(-50))); } catch (_) { /* per-viewer convenience only */ }
        }
      }
      paintMakeStatus();
    });
  }
  // SIZE a made prop (library-wide, free): the art re-registers at the new size and this floor's copies are
  // re-laid at the new box as ONE undo. A copy that no longer fits aborts the whole resize and says so.
  async function sizeMadeProp(dir, targetId) {
    const made = typeof UserProps !== 'undefined' && UserProps.get ? UserProps.get(targetId || propType) : null;
    if (!made) return;
    const steps = UserProps.SCALES, cur = steps.includes(made.scale) ? made.scale : 1;
    const next = steps[Math.max(0, Math.min(steps.length - 1, steps.indexOf(cur) + dir))];
    if (next === cur) return;
    const g = UserProps.geometry(made, next);
    // check this floor first: every copy must fit at the new box before anything changes
    const copies = station ? station.props().filter((p) => p.t === made.id) : [];
    const boxOf = (p) => ((p.r | 0) & 1) && g.side ? g.side.footprint : ((p.r | 0) & 1) && made.symmetric ? { w: g.front.footprint.h, h: g.front.footprint.w } : g.front.footprint;
    let res = { ok: true };
    if (copies.length && station.transact) {
      res = station.transact(() => {
        for (const p of copies) { const x = station.removeProp(p.id); if (!x.ok) return x; }
        for (const p of copies) { const b = boxOf(p); const x = station.addProp({ t: p.t, x: p.x, y: p.y, w: b.w, h: b.h, r: p.r, m: p.m }); if (!x.ok) return x; }
        return { ok: true };
      });
    }
    if (!res.ok) { makeJob = null; makeMsg = { text: 'At ' + Math.round(next * 100) + '% ' + copies.length + ' placed ' + (copies.length === 1 ? 'copy does' : 'copies do') + ' not fit where ' + (copies.length === 1 ? 'it stands' : 'they stand') + '. Move things aside or pick a smaller size.', tone: 'bad' }; paintMakeStatus(); return; }
    const r = await UserProps.setScale(made.id, next);
    if (!r || !r.ok) { if (copies.length && station.undo) station.undo(); makeJob = null; makeMsg = { text: (r && r.message) || 'That size could not be saved.', tone: 'bad' }; paintMakeStatus(); return; }
    makeJob = null;
    makeMsg = { text: (made.label || 'Prop') + ' size ' + Math.round(next * 100) + '% \u00b7 ' + g.front.footprint.w + '\u00d7' + g.front.footprint.h + ' tiles' + (copies.length ? ' \u00b7 ' + copies.length + ' placed ' + (copies.length === 1 ? 'copy' : 'copies') + ' resized' : ''), tone: 'ok' };
    if (selectedPropId && station) {   // the selected copy was re-laid under a new id: keep it selected
      const sel = copies.find((p) => p.id === selectedPropId);
      if (sel) { const now2 = station.props().find((p) => p.t === made.id && p.x === sel.x && p.y === sel.y); selectedPropId = now2 ? now2.id : null; }
      setHint(makeMsg.text);
    }
    if (root) { renderPalette(); renderSelection(); }
    paintMakeStatus();
  }
  // DELETE a made prop: the station deletes it first (files, index, tombstone); only then are its placed copies on
  // this floor removed, as one undo. Credits spent are not refunded, and the armed label says so before it happens.
  async function deleteMadeProp() {
    const made = typeof UserProps !== 'undefined' && UserProps.get ? UserProps.get(propType) : null;
    if (!made) return;
    const r = await UserProps.remove(made.id);
    if (!r || !r.ok) { makeJob = null; makeMsg = { text: (r && r.message) || 'That prop could not be deleted.', tone: 'bad' }; paintMakeStatus(); return; }
    const copies = station ? station.props().filter((p) => p.t === made.id).map((p) => p.id) : [];
    if (copies.length && station.transact) station.transact(() => { for (const id of copies) { const x = station.removeProp(id); if (!x.ok) return x; } return { ok: true }; });
    if (typeof PropSprites !== 'undefined' && PropSprites.unregisterUserProp) PropSprites.unregisterUserProp(made.id);
    propType = 'plant'; propCat = 'all'; selectedPropId = null;
    makeJob = null;
    makeMsg = { text: 'Deleted ' + (made.label || 'that prop') + (copies.length ? ' \u00b7 removed ' + copies.length + ' placed ' + (copies.length === 1 ? 'copy' : 'copies') : ''), tone: 'ok' };
    if (root) { renderPalette(); setLibraryPlacement(false); }
    paintMakeStatus();
    focusMakeInput();
  }
  function makePropPanel() {
    const box = document.createElement('section'); box.className = 'refit-makeprop'; box.setAttribute('aria-label', 'Make a prop');
    box.innerHTML = '<div class="refit-makeprop-head"><b>MAKE A PROP</b><small>Type any object. StarNet draws it in the station\u2019s style.</small></div>' +
      '<div class="refit-makeprop-cta" id="refit-makeprop-cta" hidden><span></span><button type="button" class="bb sm" id="refit-makeprop-cta-go"></button></div>' +
      '<div class="refit-makeprop-row"><input type="text" class="refit-input refit-searchfield" id="refit-makeprop-input" maxlength="60" spellcheck="false" autocomplete="off" aria-label="Object to make" placeholder="e.g. a grandfather clock">' +
      '<button type="button" class="bb sm" id="refit-makeprop-go">PREVIEW</button></div>' +
      '<div class="refit-makeprop-preview" id="refit-makeprop-preview" hidden></div>' +
      '<div class="refit-makeprop-foot"><span class="refit-makeprop-status" id="refit-makeprop-status" role="status" aria-live="polite"></span>' +
      '<button type="button" class="bb sm" id="refit-makeprop-door" hidden>\u25b8 STARNET CREDITS</button></div>' +
      '<div class="refit-makeprop-size" id="refit-makeprop-size" hidden><span class="refit-makeprop-sizelbl">SIZE</span><button type="button" class="bb sm" data-size="-1" aria-label="Smaller">\u2212</button><b class="refit-makeprop-sizeval">100%</b><button type="button" class="bb sm" data-size="1" aria-label="Bigger">+</button></div>' +
      '<div class="refit-makeprop-actions"><button type="button" class="bb sm refit-makeprop-sidebtn" id="refit-makeprop-side" hidden>\u21bb MAKE SIDE VIEW</button>' +
      '<button type="button" class="bb sm" id="refit-makeprop-del" hidden>\u2715 DELETE</button></div>';
    const inp = box.querySelector('#refit-makeprop-input'), go = box.querySelector('#refit-makeprop-go');
    inp.value = makeDraft;
    inp.oninput = () => { makeDraft = inp.value; };
    inp.onfocus = () => { makeFocused = true; };
    inp.onblur = () => { makeFocused = false; };
    if (makeFocused) setTimeout(() => { if (!inp.isConnected) return; inp.focus({ preventScroll: true }); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) { /* not a text control */ } }, 0);
    go.onclick = () => { startPreviewProp(inp.value); sfx('click'); };
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); if (!go.disabled) startPreviewProp(inp.value); return; }
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();   // like the search field: Escape leaves the field, never closes BUILD MODE behind it
      inp.blur();
    };
    box.querySelector('#refit-makeprop-side').onclick = () => { startMakeSide(); sfx('click'); };
    box.querySelectorAll('[data-size]').forEach((b) => { b.onclick = () => { sizeMadeProp(Number(b.dataset.size)); sfx('click'); }; });
    const delBtn = box.querySelector('#refit-makeprop-del');
    const copiesHere = station && UserProps.get && UserProps.get(propType) ? station.props().filter((p) => p.t === propType).length : 0;
    if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) ArmConfirm.wire(delBtn, { armedLabel: '\u2715 DELETE FOR GOOD?' + (copiesHere ? ' \u00b7 removes ' + copiesHere + ' placed ' + (copiesHere === 1 ? 'copy' : 'copies') : '') + ' \u00b7 credits are not refunded', onArm: () => sfx('bad'), onConfirm: () => deleteMadeProp() });
    box.querySelector('#refit-makeprop-door').onclick = openCreditsDoor;
    box.querySelector('#refit-makeprop-cta-go').onclick = () => { openCreditsDoor(); sfx('click'); };
    setTimeout(() => { paintMakeStatus(); paintPreviewCard(); resumeMakeJob(); }, 0);
    return box;
  }

  function propSearchRow() {
    const row = document.createElement('div'); row.className = 'refit-propsearch';
    const inp = document.createElement('input');
    // type=text, NOT type=search — a search field gets the UA's own ✕ and cancel affordance, which is raw
    // OS chrome sitting inside a CRT panel (the no-white-controls order). We draw our own clear key.
    inp.type = 'text';
    inp.className = 'refit-input refit-searchfield';
    inp.id = 'refit-propsearch-input';
    inp.value = propQuery;
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'Search props');
    // the count is READ from the catalog — a hardcoded "120" becomes a lie the first time a prop lands
    inp.placeholder = 'Search ' + catalog().length + ' props · name, category or ability';
    inp.oninput = () => {
      propQuery = inp.value;
      if (tool === 'prop') setLibraryPlacement(false);
      renderPropGrid();
    };
    inp.onkeydown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();   // a clear must never bubble out and close BUILD MODE behind the Commander
      if (inp.value) { clearSearch(); sfx('click'); }
      else inp.blur();        // an already-empty field hands Escape back to the editor
    };
    row.appendChild(inp);

    const clr = document.createElement('button');
    clr.type = 'button';
    clr.className = 'bb sm refit-searchclear';
    clr.textContent = '✕';
    clr.title = 'clear search';
    clr.onclick = () => { clearSearch(); sfx('click'); };
    row.appendChild(clr);
    return row;
  }

  /* rebuild ONLY the gallery and category selection. Runs on every keystroke and every tile
     pick, so it must never re-create the <input> above it. */
  function renderPropGrid() {
    const host = root && root.querySelector('#refit-propgrid-host');
    if (!host) return;
    if (host.dataset.shelfKey) propShelfScroll.set(host.dataset.shelfKey, host.scrollTop);
    const on = isSearching();
    const shelfKey = on ? 'search:'+propQuery.trim() : [propSection,propCat,propAbility].join(':');
    host.dataset.shelfKey = shelfKey;
    const workspace = root.querySelector('.refit-propworkspace');
    workspace.dataset.section = propSection; workspace.classList.toggle('is-searching', on);
    const overview = workspace.querySelector('.refit-ability-overview');
    if (overview) overview.hidden = propSection !== 'abilities' || on;
    workspace.classList.toggle('is-core-view', !on && propSection === 'abilities' && !propAbility);
    root.querySelectorAll('[data-prop-section]').forEach(b => {
      const active = !on && b.dataset.propSection === propSection;
      b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active));
    });
    root.querySelectorAll('.refit-propcat').forEach(b => {
      const active = !on && b.dataset.cat === propCat;
      b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active));
    });
    const clr = root.querySelector('.refit-searchclear');
    const menu = root.querySelector('.refit-category-menu');
    if (menu) {
      if (on) menu.open = false;
      menu.hidden = on || propSection === 'abilities';
      menu.querySelector('.refit-category-current').textContent = propCat === 'all' ? 'ALL ' + SECTION_NAMES[propSection] : catLabelOf(propCat);
    }
    if (clr) clr.style.display = propQuery ? '' : 'none';

    propThumbs.length = 0;   // the gallery is the only thumb source; free the outgoing tiles' canvases
    host.innerHTML = '';
    const list = propsForGrid();
    if (!on && propSection === 'abilities') {
      const intro = document.createElement('div'); intro.className = 'refit-ability-intro';
      intro.innerHTML = '<b>' + esc(propAbility ? abilityName(propAbility) + ' · CHOOSE A DESIGN' : 'FIVE CORE ABILITIES') + '</b><span>' +
        esc(propAbility ? 'Same ability, different appearance. One matching prop is enough in the relevant room.' : 'Real tools. Pick one design per ability you need.') + '</span>';
      if (propAbility) {
        const back = document.createElement('button'); back.type = 'button'; back.className = 'bb sm refit-ability-back'; back.textContent = '← ALL ABILITIES';
        back.onclick = () => { propAbility = ''; renderPropGrid(); }; intro.prepend(back);
      }
      host.appendChild(intro);
    }
    {
      const note = document.createElement('div');
      note.className = 'refit-searchnote' + (list.length ? '' : ' none');
      note.setAttribute('role', 'status');
      note.textContent = list.length
        ? (on ? 'SEARCH · ALL CATEGORIES' : propSection === 'abilities' ? 'ABILITY EQUIPMENT' : propCat === 'all' ? SECTION_NAMES[propSection] : catLabelOf(propCat)) + ' / ' + list.length + ' ITEMS'
        : on ? 'No props match “' + propQuery.trim() + '”. Try a name or ability, such as web, files or desk.' : 'No equipment in this category.';
      if (!on && propSection === 'abilities') note.hidden = true;
      host.appendChild(note);
      if (!list.length && on) {
        const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'bb sm'; reset.textContent = 'CLEAR SEARCH';
        reset.onclick = () => clearSearch(); host.appendChild(reset);
      }
    }
    const grid = document.createElement('div'); grid.className = 'refit-propgrid';
    grid.setAttribute('aria-label', 'Props');
    const coreView = !on && propSection === 'abilities' && !propAbility;
    if (coreView) grid.classList.add('refit-core-grid');
    list.forEach(c => grid.appendChild(propTile(c, coreView)));
    host.appendChild(grid);
    if (coreView) {
      const coreCaps = new Set(list.map(capOf));
      const extras = catalog().filter(c => sectionOf(c) === 'abilities' && !coreCaps.has(capOf(c)));
      if (extras.length) {
        const label = document.createElement('div'); label.className = 'refit-ability-intro';
        label.innerHTML = '<b>CONNECTED SERVICES</b><span>Optional equipment for connected accounts and tools.</span>'; host.appendChild(label);
        const extraGrid = document.createElement('div'); extraGrid.className = 'refit-propgrid';
        extras.forEach(c => extraGrid.appendChild(propTile(c))); host.appendChild(extraGrid);
      }
    }
    renderPropPreview();
    renderEquipmentInfo();
    host.scrollTop = propShelfScroll.get(shelfKey) || 0;
    try { paintThumbs(performance.now(), true); } catch (e) {}   // paint each card once; animate only the selected/hovered item
  }

  // The selected prop's existing palette explains purpose, scope and effective access.
  function libraryAgent() {
    const agents = (opts && opts.agents && opts.agents()) || [];
    const h = typeof StationUI !== 'undefined' && StationUI.h;
    const chosen = h && h.present && h.present[h.sel];
    if (!agents.some(a => a.id === equipmentAgentId)) equipmentAgentId = (chosen && chosen.id) || (agents[0] && agents[0].id) || 'agent';
    return { agents, id: equipmentAgentId };
  }
  function renderAbilityOverview() {
    const wrap = document.createElement('section'); wrap.className = 'refit-ability-overview'; wrap.setAttribute('aria-label', 'Core tool access');
    const { agents, id } = libraryAgent();
    wrap.innerHTML = '<div class="refit-access-head"><label>TOOL ACCESS FOR <select class="refit-input" aria-label="Inspect equipment for agent">' +
      agents.map(a => '<option value="' + esc(a.id) + '"' + (a.id === id ? ' selected' : '') + '>' + esc(a.name || a.id) + '</option>').join('') +
      '</select></label><button class="bb xs" type="button" aria-label="Refresh tool access" data-refresh-access>↻</button></div><div class="refit-core-access"></div>';
    const chips = wrap.querySelector('.refit-core-access');
    starterProps().forEach(c => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bb refit-access-chip'; b.dataset.accessCap = capOf(c);
      b.innerHTML = '<b>' + esc(grantLabelOf(c)) + '</b><span>CHECKING</span>';
      b.onclick = () => chooseAbility(capOf(c)); chips.appendChild(b);
    });
    wrap.querySelector('select').onchange = ev => { equipmentAgentId = ev.target.value; renderEquipmentInfo(); };
    wrap.querySelector('[data-refresh-access]').onclick = () => { equipmentAccessKey = ''; renderEquipmentInfo(); };
    return wrap;
  }
  function refreshLibraryAccess(facts, aid) {
    const key = [aid, geoVer, facts.placed.join(',')].join('|');
    const paint = (view, pending = false) => {
      if (!root || !root.querySelector('.refit-ability-overview')) return;
      root.querySelectorAll('[data-access-cap]').forEach(b => {
        const a = EquipmentHelp.access(b.dataset.accessCap, view);
        b.dataset.state = pending ? 'pending' : a.state;
        b.querySelector('span').textContent = pending ? 'CHECKING' : a.label;
        b.setAttribute('aria-label', abilityName(b.dataset.accessCap) + ' · ' + (pending ? 'Checking access' : a.label));
      });
      root.querySelectorAll('[data-core-ability]').forEach(b => {
        const a = EquipmentHelp.access(b.dataset.coreAbility, view);
        b.dataset.state = pending ? 'pending' : a.state;
        b.querySelector('.refit-core-status').textContent = pending ? 'CHECKING ACCESS' : a.label;
      });
      const status = root.querySelector('.refit-propinspector .equipment-status');
      if (status) status.textContent = pending ? 'Checking current access…' : EquipmentHelp.status(facts, view);
    };
    if (key === equipmentAccessKey) { paint(equipmentAccessView, equipmentAccessView === undefined); return; }
    equipmentAccessKey = key; equipmentAccessView = undefined;
    const ticket = ++equipmentAccessTicket; paint(null, true);
    Harness.api.get('/api/toolsets?agent=' + encodeURIComponent(aid) + '&placed=' + encodeURIComponent(facts.placed.join(',')))
      .catch(() => null).then(view => {
        if (ticket !== equipmentAccessTicket || !root || !root.isConnected) return;
        equipmentAccessView = view;
        // Selection may have changed while this request was in flight; re-read its facts.
        renderEquipmentInfo();
      });
  }
  function renderLibraryInfo(spec) {
    const inspector = root.querySelector('.refit-propinspector');
    if (!inspector) return;
    let box = inspector.querySelector('.refit-equipment-info');
    if (!box) {
      box = document.createElement('div'); box.className = 'refit-equipment-info';
      box.id = 'refit-prop-details';
      const preview = inspector.querySelector('#refit-selected-prop');
      preview.insertBefore(box, preview.querySelector('.refit-placement-note'));
    }
    const { id } = libraryAgent(), facts = EquipmentHelp.inspect(station, id, spec.id), category = sectionOf(spec);
    const key = [spec.id, id, geoVer].join('|');
    if (box.dataset.infoKey !== key) {
      box.dataset.infoKey = key;
      const purpose = facts.purpose || PALETTE_PURPOSE[spec.id] || spec.desc || (category === 'decoration' ? 'Changes the look of your station. Adds no agent tools.' : 'Equipment for arranging work in the station.');
      box.innerHTML = '<p class="refit-purpose">' + esc(purpose) + '</p>' +
        (facts.cap ? '<div class="equipment-status" role="status">Checking current access…</div><div class="refit-equipment-scope">' +
        esc('Equipment sharing: ' + facts.scope + '.') + '</div>' :
        category === 'decoration' ? '' : '<div class="refit-equipment-scope">Organizes the station; does not add an ability.</div>') +
        '<div class="refit-equipment-detail">' + esc(facts.cap ? facts.duplicates : spec.desc || '') +
        (facts.cap ? '<p>Without a workflow bay, an agent draws on station equipment. With a bay, it uses equipment in its desk room (or bay room if there is no desk). Each workflow agent needs its own desk.</p><p>Connected accounts and providers are configured in Abilities.</p>' : '') + '</div>';
    }
    refreshLibraryAccess(facts, id);
  }
  function renderEquipmentInfo(selectedType, placedProp) {
    const pal = root && root.querySelector('#refit-palette');
    if (!pal || typeof EquipmentHelp === 'undefined') return;
    const spec = catalog().find(c => c.id === (selectedType || propType));
    if (!spec) return;
    if (tool === 'select' && buildGroup === 'props' && !selectedType) {
      if (propSection === 'abilities') renderLibraryInfo(spec);
      return;
    }
    if (typeof Tutorial !== 'undefined' && Tutorial.onEquipmentInspect) Tutorial.onEquipmentInspect();
    if (tool === 'prop' && pal.querySelector('.refit-ability-overview')) return renderLibraryInfo(spec);
    let box = pal.querySelector('.refit-equipment-info');
    if (!box) { box = document.createElement('div'); box.className = 'refit-equipment-info'; (pal.querySelector('.refit-propinspector') || pal).appendChild(box); }
    const agents = (opts && opts.agents && opts.agents()) || [];
    const h = typeof StationUI !== 'undefined' && StationUI.h;
    const chosen = h && h.present && h.present[h.sel];
    const aid = box.querySelector('select')?.value || (chosen && chosen.id) || (agents[0] && agents[0].id) || 'agent';
    const infoKey = [spec.id, aid, geoVer, placedProp && placedProp.id].join('|');
    if (box.dataset.infoKey === infoKey) return;
    box.dataset.infoKey = infoKey;
    const facts = EquipmentHelp.inspect(station, aid, spec.id);
    const sharingOpen = !!box.querySelector('details[open]');
    const propRoom = placedProp && station.roomById(station.roomAt(placedProp.x, placedProp.y));
    box.innerHTML = '<p class="refit-purpose">' + esc(facts.purpose || spec.desc || 'Station decoration.') + '</p>'
      + (facts.cap ? (agents.length > 1 ? '<label> For <select class="refit-input" aria-label="Inspect equipment for agent">' + agents.map(a => '<option value="' + esc(a.id) + '"' + (a.id === aid ? ' selected' : '') + '>' + esc(a.name || a.id) + '</option>').join('') + '</select></label>' : '')
      + '<div class="equipment-status" role="status">Checking current access…</div>'
      + '<div>Equipment scope: ' + esc(facts.scope) + (propRoom ? ' · This copy: ' + esc(propRoom.name || propRoom.id) : '') + '</div>'
      + '<details' + (sharingOpen ? ' open' : '') + '><summary>Sharing, rooms & extra copies</summary><p>' + facts.count + ' matching prop' + (facts.count === 1 ? '' : 's') + '. ' + esc(facts.duplicates) + '</p>Without a workflow bay, the lead draws on equipment across the station. With a bay, an agent uses its desk room (or the bay room if it has no desk). Agents in that room share equipment; each needs its own desk. Moving or removing the last matching prop changes that room’s equipment; access settings may still supply its tools. Connect external services in Abilities.</details>' : '<div>' + esc(facts.duplicates) + '</div>');
    const select = box.querySelector('select');
    if (select) select.onchange = () => renderEquipmentInfo(spec.id, placedProp);
    const status = box.querySelector('.equipment-status');
    if (!status) return;
    Harness.api.get('/api/toolsets?agent=' + encodeURIComponent(aid) + '&placed=' + encodeURIComponent(facts.placed.join(',')))
      .then(view => { if (status.isConnected) status.textContent = EquipmentHelp.status(facts, view); })
      .catch(() => { if (status.isConnected) status.textContent = EquipmentHelp.status(facts, null); });
  }

  /* MAKE A PROP, AS ONE ROW (2026-10-01 build-mode upgrade — Andrew: "it needs to be easier and more fun to use"). At 1440×900 the
     whole panel (a heading, two lines of copy, the credits card, the field, the cost line) plus the category menu and the hint box
     left the Props tab showing ZERO props. The panel now rests as one row — MAKE A PROP and, where linking is possible, the panel's
     own credits key (conversion stays in view) — and opens in place on a click. It is held OPEN whenever a paid job is running, a
     preview or a message is waiting, or the field has the focus (the props lane's rule: a job the Commander paid for is never hidden
     behind a key). The panel itself is makePropPanel(), untouched — every id and class it renders. */
  let makeOpen = false;
  function makePropMount() {
    const box = makePropPanel();
    const busy = !!(makeJob && makeJob.status !== 'done' && makeJob.status !== 'failed') || !!makePreview || !!makeMsg;
    const open = makeOpen || busy;
    box.classList.toggle('is-compact', !open);
    const head = box.querySelector('.refit-makeprop-head');
    if (head) {
      head.setAttribute('role', 'button'); head.tabIndex = 0;
      head.setAttribute('aria-expanded', String(open));
      head.dataset.tip = open ? 'Close MAKE A PROP' : 'Make your own prop: type any object, StarNet draws it in the station\u2019s style (StarNet credits)';
      const toggle = () => {
        if (busy) return;   // a running job, a preview or a message keeps it open
        makeOpen = !box.classList.contains('is-compact') ? false : true;
        box.classList.toggle('is-compact', !makeOpen); head.setAttribute('aria-expanded', String(makeOpen));
        sfx('click');
        if (makeOpen) setTimeout(() => { const f = box.querySelector('#refit-makeprop-input'); if (f) f.focus(); }, 0);
      };
      head.onclick = toggle;
      head.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
    }
    const inp = box.querySelector('#refit-makeprop-input');
    if (inp) inp.addEventListener('focus', () => { makeOpen = true; box.classList.remove('is-compact'); if (head) head.setAttribute('aria-expanded', 'true'); });
    return box;
  }
  // a placed prop's own art, small — the selection card shows WHAT is selected, not only its name
  function propArtInto(host, p) {
    if (!host || !p || typeof PropSprites === 'undefined') return;
    const nativeW = (p.w || 1) * 12 + 24, nativeH = (p.h || 1) * 12 + 24;
    const density = typeof PropRemaster !== 'undefined' && PropRemaster.isProjection && PropRemaster.isProjection() ? 4 : 1;
    const off = document.createElement('canvas'); off.width = nativeW * density; off.height = nativeH * density;
    const o = off.getContext('2d'); o.scale(density, density); o.translate(12, 12); o.imageSmoothingEnabled = true;
    try { PropSprites.setCtx(o); PropSprites.setNow(0); PropSprites.draw({ t: p.t, x: 0, y: 0, w: p.w || 1, h: p.h || 1, r: p.r | 0, m: p.m ? 1 : 0, text: p.text || '' }, false); }
    catch (e) { return; }
    finally { if (ctx) PropSprites.setCtx(ctx); }
    const c = document.createElement('canvas'); c.width = 84; c.height = 54;   // the card's art well (refit-easy.css .refit-sel-art)
    const d = c.getContext('2d'); d.imageSmoothingEnabled = true; d.imageSmoothingQuality = 'high';
    const s = Math.min(c.width / nativeW, c.height / nativeH), w = Math.round(nativeW * s), h = Math.round(nativeH * s);
    d.drawImage(off, Math.round((c.width - w) / 2), Math.round((c.height - h) / 2), w, h);
    host.appendChild(c);
  }
  // the Surfaces tab shows its finishes with nothing armed: the first material or colour picked there arms SURFACE (capture
  // phase, so the chip's own handler then sets the pick on the armed tool's palette)
  function armPaintFromBrowse(e) {
    if (tool === 'select' && buildGroup === 'surfaces' && e.target && e.target.closest && e.target.closest('.refit-mattile, .refit-hue')) selectTool('paint', { silent: true });
  }
  function renderPalette() {
    const pal = root.querySelector('#refit-palette');
    if (!pal) return;
    const previousShelf = pal.querySelector('#refit-propgrid-host');
    if (previousShelf?.dataset.shelfKey) propShelfScroll.set(previousShelf.dataset.shelfKey,previousShelf.scrollTop);
    if (pal.querySelector('.refit-linegrid')) propShelfScroll.set('workflow-layouts',pal.scrollTop);
    bumpUi();   // the dock is about to change height/width — positionFinCard must re-measure it
    const section = root.querySelector('#refit-option-section');
    const label = root.querySelector('#refit-palette-label');
    let paletteLabel = '';
    root.dataset.tool = tool;
    root.dataset.buildGroup = buildGroup;
    root.dataset.catalog = String((tool === 'prop' && buildGroup !== 'workflow') || ((tool === 'select' || tool === 'dupe') && buildGroup === 'props'));
    root.querySelectorAll('[data-build-group]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.buildGroup === buildGroup)));
    root.querySelectorAll('.refit-toolset').forEach(g => { g.hidden = g.dataset.group !== buildGroup; });
    pal.innerHTML = '';
    propThumbs.length = 0;   // drop any preview tiles from a prior render (they're rebuilt below for the prop tool)
    /* THE TABS SHOW THEIR THINGS (2026-10-01 build-mode upgrade). Rooms, Surfaces and Edit each opened on a title, one sentence
       and an empty glass until you armed their tool. Now Rooms opens on its room types and Surfaces on its finishes — picking
       one arms the tool with it (the branches below) — and Edit on the editor's keys, as key caps, with the object finder. */
    if (tool === 'select' && buildGroup === 'edit') {
      paletteLabel = 'INSPECT';
      const note = document.createElement('div');
      note.className = 'refit-selectnote refit-keycard';
      const KEYS = [['Click', 'select it'], ['Drag a box', 'select several'], ['Double-click', 'a whole line'], ['Shift + click', 'add or drop one'], ['Drag a machine', 'onto another: belt them'], ['Drag a selected one', 'onto floor: move it'], ['Shift + drag', 'move any piece'], ['Right-click', 'remove a piece'], ['Ctrl + drag a belt', 'reshape it'], ['Q · Alt', 'pick up · every setting'],
        ['Arrows', 'nudge · Shift: 5'], ['R · M', 'turn · flip'], ['Ctrl + D', 'duplicate'], ['Ctrl + C · X · V', 'copy · cut · paste'], ['Del', 'delete'], ['Ctrl + Z', 'undo'],
        ['Click a room', 'move · resize · furnish']];
      note.innerHTML = '<b>Click anything to edit</b><div class="refit-keyrows">' + KEYS.map(([k, v]) => '<span class="refit-keyrow"><kbd>' + esc(k) + '</kbd><span>' + esc(v) + '</span></span>').join('') + '</div>';
      pal.appendChild(note);
      const finder=document.createElement('select');finder.setAttribute('aria-label','Find a placed object');finder.className='refit-object-finder';
      const refresh=()=>{finder.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='Find a placed object…';finder.append(blank);
        for(const p of station.props().slice().sort((a,b)=>propLabel(a.t).localeCompare(propLabel(b.t)))){const o=document.createElement('option');o.value=p.id;o.textContent=propLabel(p.t)+' · '+p.x+', '+p.y;finder.append(o);}};
      refresh();finder.onfocus=refresh;
      finder.onchange=()=>{const p=station.propById(finder.value);if(!p)return;onInspect(p,orientEv());zoom=Math.max(zoom,1);panX=cv.width*.72-(p.x+p.w/2)*T()*zoom;panY=cv.height*.5-(p.y+p.h/2)*T()*zoom;};
      note.insertBefore(finder, note.querySelector('.refit-keyrows'));   // the finder first (it acts), the keys under it (they teach)
    } else if (tool === 'room' || (tool === 'select' && buildGroup === 'rooms')) {
      /* ROOM TYPE was the last palette in BUILD MODE still made of bare text chips, next to a prop
         gallery of live animated previews and a material grid painted by the real bake. A room
         kind IS a deck (a hue × a material), so it can preview itself the same honest way every
         other surface here does — through StationBake, so the chip can never promise a floor the
         station won't deliver. Now you pick FOUNDRY because you can see the rust tread. */
      paletteLabel = 'TYPE';
      const grid = document.createElement('div'); grid.className = 'refit-matgrid refit-kindgrid';
      grid.setAttribute('aria-label', 'Room types');
      station.KIND_ORDER.forEach(k => {
        const def = station.ROOM_KINDS[k]; if (!def) return;
        const active = tool === 'room' && k === kind;   // nothing armed = nothing lit: the grid is a choice, not a state
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-mattile refit-kindtile' + (active ? ' active' : '');
        b.dataset.kind = k;
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
        const hue = (station.FLOOR_STYLES[def.floor] || station.FLOOR_STYLES.hull).base;
        b.appendChild(matSwatchCanvas(def.mat || 'plate', hue, 5, 3));
        const nm = document.createElement('span'); nm.className = 'refit-matname'; nm.textContent = def.label;
        b.appendChild(nm);
        const hueDef = station.FLOOR_STYLES[def.floor];
        b.title = def.label + ' — ' + ((station.FLOOR_MATERIALS[def.mat] || {}).label || def.mat || 'plate')
          + ' deck in ' + ((hueDef && hueDef.label) || def.floor) + ' (SURFACE re-lays it any time)';
        b.onclick = () => { kind = k; if (tool !== 'room') selectTool('room', { silent: true }); else { renderPalette(); setHint(); } sfx('click'); };
        grid.appendChild(b);
      });
      pal.appendChild(grid);
      const note = document.createElement('div');
      note.className = 'refit-linenote';
      note.textContent = 'A type is just the deck it starts with — SURFACE (3) re-lays any room later.';
      pal.appendChild(note);
    } else if (tool === 'hall') {
      paletteLabel = 'WIDTH';
      [1, 2, 3].forEach(w => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-kind' + (w === hallWidth ? ' active' : '');
        b.setAttribute('aria-pressed', w === hallWidth ? 'true' : 'false');
        b.textContent = w + (w === 1 ? ' tile' : ' tiles');
        b.onclick = () => { hallWidth = w; renderPalette(); sfx('click'); };
        pal.appendChild(b);
      });
    } else if ((tool === 'prop' && buildGroup !== 'workflow') || ((tool === 'select' || tool === 'dupe') && buildGroup === 'props')) {
      paletteLabel = 'CATALOG';
      const CATS = (typeof PropSprites !== 'undefined') ? PropSprites.CATS : {};
      const workspace = document.createElement('div'); workspace.className = 'refit-propworkspace';
      const browser = document.createElement('div'); browser.className = 'refit-propbrowser';
      const search = propSearchRow();
      const sections = document.createElement('nav'); sections.className = 'refit-prop-sections'; sections.setAttribute('aria-label', 'Prop purpose');
      for (const id of Object.keys(SECTION_NAMES)) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'bb refit-prop-section'; b.dataset.propSection = id;
        b.textContent = SECTION_NAMES[id]; b.onclick = () => chooseLibrarySection(id); sections.appendChild(b);
      }
      const details = document.createElement('button'); details.type = 'button'; details.className = 'bb sm refit-details-toggle'; details.textContent = 'DETAILS ▾';
      details.setAttribute('aria-expanded', 'false');
      details.setAttribute('aria-controls', 'refit-prop-details');
      details.onclick = () => {
        const expanded = workspace.classList.toggle('show-details');
        details.setAttribute('aria-expanded', String(expanded));
        details.textContent = expanded ? 'LESS ▴' : 'DETAILS ▾';
        details.scrollIntoView({ block: 'nearest' });
      };
      browser.append(search, sections);
      if (propSection === 'decoration' && typeof UserProps !== 'undefined') browser.append(makePropMount());
      else if (typeof UserProps !== 'undefined') {   // the door to MAKE A PROP from the other shelves: one click to FURNITURE with the field focused
        const door = document.createElement('button'); door.type = 'button'; door.className = 'bb sm refit-makeprop-door';
        door.innerHTML = '<b>MAKE A PROP</b><small>Type any object. StarNet draws it in the station\u2019s style.</small>';
        door.onclick = () => { makeOpen = true; chooseLibrarySection('decoration'); setTimeout(() => { const f = root && root.querySelector('#refit-makeprop-input'); if (f) f.focus(); }, 0); sfx('click'); };
        browser.append(door);
      }
      browser.append(renderAbilityOverview());
      const shelves = document.createElement('div'); shelves.className = 'refit-shelves';
      const categoryMenu = document.createElement('details'); categoryMenu.className = 'refit-category-menu';
      const categoryTrigger = document.createElement('summary'); categoryTrigger.id = 'refit-category-trigger';
      categoryTrigger.innerHTML = '<span class="refit-category-label">CATEGORY</span><b class="refit-category-current"></b><span class="refit-category-arrow" aria-hidden="true">▾</span>';
      categoryMenu.appendChild(categoryTrigger);
      const catRow = document.createElement('nav'); catRow.className = 'refit-propcats';
      catRow.setAttribute('aria-label', 'Prop categories');
      const sectionProps = catalog().filter(c => sectionOf(c) === propSection);
      ['all', ...new Set(sectionProps.map(c => c.cat))].forEach(g => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-propcat' + (g === propCat ? ' active' : '');
        b.dataset.cat = g;   // lets the tutorial light the exact category tab a step needs
        b.setAttribute('aria-pressed', g === propCat ? 'true' : 'false');
        const count = g === 'all' ? sectionProps.length : sectionProps.filter(c => c.cat === g).length;
        const name = g === 'all' ? 'ALL ' + SECTION_NAMES[propSection] : catLabelOf(g);
        b.setAttribute('aria-label', name + ' · ' + count + ' items');
        b.innerHTML = '<span>' + esc(name) + '</span><small>' + count + '</small>';
        b.onclick = () => { propQuery = ''; propCat = g; selectTool('select'); };
        catRow.appendChild(b);
      });
      categoryMenu.appendChild(catRow); shelves.appendChild(categoryMenu);
      const gridHost = document.createElement('div'); gridHost.id = 'refit-propgrid-host';
      shelves.appendChild(gridHost); browser.appendChild(shelves); workspace.appendChild(browser);
      const inspector = document.createElement('aside'); inspector.className = 'refit-propinspector'; inspector.setAttribute('aria-label', 'Selected equipment details');
      const preview = document.createElement('section'); preview.id = 'refit-selected-prop';
      preview.className = 'refit-selected-prop'; preview.setAttribute('aria-label', 'Selected prop');
      inspector.appendChild(preview);
      const more = document.createElement('div'); more.className = 'refit-prop-more'; more.appendChild(details); inspector.appendChild(more);
      workspace.appendChild(inspector); pal.appendChild(workspace);
      renderPropGrid();
    } else if (tool === 'paint' || (tool === 'select' && buildGroup === 'surfaces')) {
      if (tool === 'select') pal.addEventListener('click', armPaintFromBrowse, true);   // the same function twice is one listener
      /* SURFACE — TWO AXES, TWO SECTIONS: the MATERIAL (what the surface is made of) and the HUE
         (what colour it is). They compose — every material renders in whatever colour is selected
         — so the Commander picks a room's finish the way you'd pick flooring: the stuff, then the
         shade. Both sections speak the SAME card language as the prop gallery (a dark inset chip
         with a phosphor rim). They used to be bare <button>s with only a border declared, which
         let the UA paint its own grey buttonface + Arial behind every material name — raw HTML
         chrome sitting inside a CRT panel. Never ship a bare button here. */
      /* THREE surfaces now, not two (2026-08-05). DECK and WALLS dress the inside of a room; SHELL is
         what the station shows the sky — and it was the one surface with no palette at all. Same two
         sections, same card language: adding the axis is a third target, not a third panel. */
      const walls = paintTarget === 'walls', shell = paintTarget === 'hull';
      paletteLabel = shell ? 'SHELL' : walls ? 'WALLS' : 'DECK';
      const styles = station.FLOOR_STYLES || {};
      const matCatalog = shell ? (station.HULL_MATERIALS || {}) : walls ? (station.WALL_MATERIALS || {}) : (station.FLOOR_MATERIALS || {});
      const order = shell ? (station.HULL_ORDER || Object.keys(matCatalog))
        : walls ? (station.WALL_ORDER || Object.keys(matCatalog)) : (station.MAT_ORDER || Object.keys(matCatalog));
      const curMat = shell ? hullMat : walls ? wallMat : mat;
      const curHue = shell ? hullStyle : walls ? wallStyle : style;
      // AUTO is a MODE, not a colour, on both whole-room surfaces — see the auto chip below
      const autoOn = shell ? (hullStyle === 'follow') : (walls && wallStyle === 'follow');
      // a section caption that NAMES the live selection, so the chosen recipe and tone are readable
      // as WORDS and not only as a lit chip (21 hues can't each carry a label without a wall of text)
      const cap = (caption, value) => {
        const wrap = document.createElement('div'); wrap.className = 'refit-palcap';
        const k = document.createElement('span'); k.className = 'refit-palcap-k'; k.textContent = caption;
        wrap.appendChild(k);
        if (value) { const v = document.createElement('span'); v.className = 'refit-palcap-v'; v.textContent = value; wrap.appendChild(v); }
        pal.appendChild(wrap);
      };

      // TARGET — deck or walls. Two surfaces, one palette; reuses the tier-toggle idiom.
      const tgt = document.createElement('div'); tgt.className = 'refit-tiers';
      tgt.setAttribute('aria-label', 'Surface target');
      [['floor', '▧ DECK'], ['walls', '▤ WALLS'], ['hull', '▥ SHELL']].forEach(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-tier refit-painttarget' + (paintTarget === id ? ' active' : '');
        b.dataset.target = id;
        b.setAttribute('aria-pressed', paintTarget === id ? 'true' : 'false');
        b.textContent = label;
        b.onclick = () => { paintTarget = id; renderPalette(); setHint(); sfx('click'); };
        tgt.appendChild(b);
      });
      pal.appendChild(tgt);

      cap('MATERIAL', (matCatalog[curMat] && matCatalog[curMat].label) || '');
      const matGrid = document.createElement('div'); matGrid.className = 'refit-matgrid';
      matGrid.setAttribute('aria-label', shell ? 'Shell materials' : walls ? 'Wall materials' : 'Deck materials');
      order.forEach(mid => {
        const def = matCatalog[mid];
        if (!def) return;
        const active = mid === curMat;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-mattile' + (active ? ' active' : '');
        b.dataset.mat = mid;
        b.dataset.surface = shell ? 'hull' : walls ? 'wall' : 'floor';
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
        // a MATERIAL patch big enough to READ: five tiles across by three down clears a full cell
        // of every recipe in the catalog (SPINE's 4x3 bolted bay is the widest), so the bays, the
        // grate holes and PLANK's 5x1 boards are told apart at a glance. Drawn 1:1 at the bake's
        // own 12px tile — pixel art is never scaled, and ten patches must still fit without the
        // dock growing into a full-height wall.
        b.appendChild(shell ? hullSwatchCanvas(mid, hullBaseFor(mid), 5, 34)
          : walls ? wallSwatchCanvas(mid, wallBaseFor(mid), 5, 30) : matSwatchCanvas(mid, styleBaseFor(mid), 5, 3));
        const nm = document.createElement('span'); nm.className = 'refit-matname'; nm.textContent = def.label;
        b.appendChild(nm);
        // the shell catalog carries a one-line blurb — nine exteriors is past the point where a name
        // alone teaches the difference between CLAPBOARD and SHINGLE
        b.title = shell ? (def.label + ' — ' + (def.blurb || 'shell')) : def.label + (walls ? ' walls' : ' deck');
        // picking a material also moves the hue to the one it was drawn for (wood wants a wood
        // tone) — visibly, in the row below, so the Commander can still override it right after.
        b.onclick = () => {
          // SHELL keeps AUTO rather than pinning the suggested hue: on this axis AUTO already MEANS
          // "the tone this material was drawn for", so pinning it would only make the next material
          // pick inherit the previous one's colour.
          if (shell) hullMat = mid;
          else if (walls) { wallMat = mid; if (def.suggest && styles[def.suggest]) wallStyle = def.suggest; }
          else { mat = mid; if (def.suggest && styles[def.suggest]) style = def.suggest; }
          renderPalette(); setHint(); sfx('click');
        };
        matGrid.appendChild(b);
      });
      pal.appendChild(matGrid);

      cap('COLOUR', autoOn ? 'AUTO' : ((styles[curHue] && styles[curHue].label) || ''));
      const hueGrid = document.createElement('div'); hueGrid.className = 'refit-huegrid';
      hueGrid.setAttribute('aria-label', shell ? 'Shell colours' : walls ? 'Wall colours' : 'Deck colours');
      if (walls || shell) {
        // AUTO — walls inherit the room's deck hue; a SHELL has no deck to inherit, so its AUTO is
        // the tone its material was drawn for (TIMBER→walnut, BRICK→rust, STATION→the shell grey it
        // shipped as). Either way it's the default and the one most people want, so it leads. It is
        // NOT a colour but a MODE, which is why it takes its own full-width row instead of standing
        // in the grid as a 22nd chip.
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-hue refit-hue-auto' + (autoOn ? ' active' : '');
        b.dataset.hue = 'follow';
        b.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
        // preview what AUTO itself yields — the material's own tone, ignoring any hue currently picked
        b.appendChild(shell ? hullSwatchCanvas(hullMat, hullAutoBase(hullMat), 3, 28) : wallSwatchCanvas(wallMat, null, 3, 24));
        const nm = document.createElement('span'); nm.className = 'refit-matname';
        nm.textContent = shell ? 'AUTO — THE MATERIAL’S OWN TONE' : 'AUTO — MATCH THE DECK';
        b.appendChild(nm);
        b.title = shell ? 'the tone this material was drawn for' : 'match the room’s deck colour';
        b.onclick = () => { if (shell) hullStyle = 'follow'; else wallStyle = 'follow'; renderPalette(); sfx('click'); };
        hueGrid.appendChild(b);
      }
      // every hue chip previews the CURRENTLY SELECTED MATERIAL in that tone, painted by the real
      // bake — so the row answers "what does PLANK look like in COBALT?" instead of showing a flat
      // colour the station will never actually render.
      Object.keys(styles).forEach(sid => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-hue' + (sid === curHue ? ' active' : '');
        b.dataset.hue = sid;
        b.setAttribute('aria-pressed', sid === curHue ? 'true' : 'false');
        b.appendChild(shell ? hullSwatchCanvas(hullMat, styles[sid].base, 3, 28)
          : walls ? wallSwatchCanvas(wallMat, styles[sid].base, 3, 24) : matSwatchCanvas(mat, styles[sid].base, 3, 2));
        b.title = styles[sid].label;
        b.onclick = () => { if (shell) hullStyle = sid; else if (walls) wallStyle = sid; else style = sid; renderPalette(); sfx('click'); };
        hueGrid.appendChild(b);
      });
      pal.appendChild(hueGrid);
    } else if (tool === 'belt') {
      /* the BELT tool's idle state, in the other tabs' voice — a title and one line, like Rooms' "Make space" (2026-09-30: the
         paragraph that sat here went; the whole gesture is spelled out in the tool help under the palette) */
      paletteLabel = 'THE LINE';
      const note = document.createElement('div');
      note.className = 'refit-selectnote';
      note.innerHTML = '<b>Connect machines</b><span>Click where work starts, then where it goes next.</span>';
      pal.appendChild(note);
    } else if (tool === 'line' || ((tool === 'select' || tool === 'prop') && buildGroup === 'workflow')) {
      /* THE LINE LIBRARY (v3, 2026-08-30) — one-click whole layouts, now a browsable library.
         Cards keep the v2 anatomy (schematic MINIATURE in the floor's own colour economy, NAME +
         footprint/dock chip, one-line purpose); with 15 systems on the shelf they group into
         SECTIONS by what the line is FOR (chains ▸ sorters ▸ crews ▸ gates ▸ flagships), simplest
         family first, so the shelf reads as a curriculum — each section teaches one idea and the
         flagships assemble them. Grouping comes from the catalog's own `grp` field (worldmodel),
         never hand-kept here; an ungrouped blueprint falls into the last section rather than
         vanishing (a card the catalog ships must always be stampable). */
      paletteLabel = 'THE LINE LIBRARY';
      /* THE CONVEYORS TAB IN THE LIBRARY'S OWN LOOK (2026-09-30 — Andrew: "the long sentences underneath each machine … I hate it
         … stop resorting back to the old ugly UI"). Laid out like the Props tab beside it: two section keys (the FURNITURE ·
         EQUIPMENT · ABILITIES row's look), then a grid of big glass tiles — a line's miniature or a machine's own art, its name,
         one small line. Every sentence that used to sit under a tile is now its hover tip and its accessible description
         (simplify = organization: nothing a tile said is gone). */
      if (tool === 'line') convSection = 'lines';   // an armed line always shows its card and its SET UP row
      else if (tool === 'prop' && workflowMachines().some(c => c.id === propType)) convSection = 'machines';   // …and an armed machine its tile
      pal.appendChild(hotbarEl());   // THE HAND: the pieces you build a line from, always first, keys 1–8 (+ the touch keys)
      const secs = document.createElement('nav'); secs.className = 'refit-prop-sections refit-conv-sections'; secs.setAttribute('aria-label', 'Conveyors');
      for (const [id, label, n] of [['lines', LINES_LABEL, blueprints().length], ['machines', MACHINES_LABEL, workflowMachines().length]]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'bb refit-prop-section' + (convSection === id ? ' active' : '');
        b.dataset.convSection = id; b.setAttribute('aria-pressed', String(convSection === id));
        b.innerHTML = esc(label) + ' <small>' + n + '</small>';
        b.onclick = () => { if (convSection === id) return; convSection = id; sfx('click'); if (tool === 'line') selectTool('select', { silent: true }); else renderPalette(); };
        secs.appendChild(b);
      }
      pal.appendChild(secs);
      if (convSection === 'machines') pal.appendChild(machinePalette());
      else {
        /* BUILD YOUR OWN (conveyor-links phase D) — the Commander places the line, the station never does (Andrew 2026-10-13: "it
           should open the menu and automatically choose for the user to place an inbox, where they can click wherever they want to
           place it. Not automatically place it for the user"). The key puts an INBOX IN HAND (startNewLine — the hotbar's own hand,
           its ghost on the pointer); the click places it where they choose, and the line grows the hand's way from there. */
        const own = document.createElement('button'); own.type = 'button'; own.className = 'bb refit-ownline' + (hand && hand.newLine ? ' active' : '');
        own.setAttribute('aria-pressed', String(!!(hand && hand.newLine)));
        own.textContent = '＋ BUILD YOUR OWN LINE';
        own.dataset.tip = 'Hold an INBOX: click the floor where your line starts, then drag from it to lay the belt to its next piece';
        own.onclick = () => startNewLine();
        pal.appendChild(own);
        const grid = document.createElement('div'); grid.className = 'refit-linegrid';
        grid.setAttribute('aria-label', 'Line library');
        /* START FROM INTENT (2026-09-28): the ready-made line with the SHAPE of the Commander's own goal leads the shelf; its tip
           quotes their words so it is clear why — one click arms it (MAKE ROOM FOR IT when the deck is too small) */
        const goal = goalLine();
        if (goal) {
          grid.appendChild(lineGroupHd('FOR YOUR GOAL', 'refit-goalhd'));
          addLineCell(grid, goal.bp, '“' + goal.quote + '” — ' + goal.why, true);
        }
        const groups = {};
        const lastWork = LINE_WORK_GROUPS[LINE_WORK_GROUPS.length - 1].id;
        for (const bp of blueprints()) { const k = LINE_WORK_GROUPS.some(g => g.id === LINE_WORK[bp.id]) ? LINE_WORK[bp.id] : lastWork; (groups[k] = groups[k] || []).push(bp); }
        for (const g of LINE_WORK_GROUPS) {
          if (!groups[g.id] || !groups[g.id].length) continue;
          const open = lineShelfShown(g.id, groups[g.id]);
          grid.appendChild(g.id === LINE_SHELF_OPEN ? lineGroupHd(g.label) : lineShelfToggle(g, groups[g.id].length, open));
          if (open) for (const bp of groups[g.id]) addLineCell(grid, bp);
        }
        pal.appendChild(grid);
      }
    }
    if (pal.querySelector('.refit-linegrid')) pal.scrollTop = propShelfScroll.get('workflow-layouts') || 0;
    /* NAME THE ARMED TOOL IN THE OPTIONS HEADER. The two zones of this dock — the tool you picked
       and the options for it — were only related by adjacency: "ROOM TYPE" over a grid of decks
       does not say WHICH tool it belongs to, and the connection is the whole reason the options
       changed. The header now reads `ROOM ▸ TYPE`, the armed tool in phosphor. */
    if (label) {
      const t = TOOLS.find(x => x.id === tool);
      label.innerHTML = t
        ? '<span class="refit-pl-tool">' + esc(t.label) + '</span><span class="refit-pl-sep">▸</span>'
          + '<span class="refit-pl-what">' + esc(paletteLabel || 'OPTIONS') + '</span>'
        : esc(paletteLabel || 'OPTIONS');
    }
    if (section) section.classList.toggle('is-empty', !pal.children.length && tool === 'select');
    updateSafetyClearance();
  }

  function updateSafetyClearance() {
    if (!root || !document.body) return;
    const dock = root.querySelector('.refit-dock');
    if (!dock) return;
    const top = root.querySelector('.refit-top');
    const bottomSheet = window.matchMedia('(max-width: 700px)').matches;
    if (bottomSheet) dock.style.removeProperty('top');
    else if (top) dock.style.top = (top.offsetHeight + 10) + 'px';
    document.body.style.setProperty('--refit-dock-clearance', bottomSheet ? (dock.offsetHeight + 20) + 'px' : '58px');
  }

  function toggleKit(collapsed) {
    const dock = root && root.querySelector('.refit-dock'); if (!dock) return;
    const hide = collapsed == null ? !dock.classList.contains('is-collapsed') : collapsed;
    if (!hide) wfKitAuto = false;   // the library was (re)opened — the Workflow panel no longer owes it a restore
    dock.classList.toggle('is-collapsed', hide);
    const b = root.querySelector('#refit-kit-toggle');
    b.textContent = hide ? 'OPEN KIT ▾' : 'MINIMIZE ▴'; b.setAttribute('aria-expanded', String(!hide));
    bumpUi(); updateSafetyClearance();
  }

  /* ---------- visual prop palette: a scrollable gallery of LIVE animated previews ----------
     Each tile carries its own mini-canvas; paintThumbs() blits the real PropSprites art into it every
     few frames (driven by the main loop) so the screens/LEDs animate exactly like the placed prop. */
  /* one line per WORKFLOW machine — what it DOES, by OUTCOME, in plain words (2026-09-27 audit P2/P3/P4: the old lines spoke
     factory — lane, crate, out-lane — and JOINER and MERGER read as the same machine). Never a footprint. */
  const PALETTE_PURPOSE = {
    intake: 'where work comes in: a schedule, a chat message, a watched folder or another app calling in starts the line here',
    bay: 'one step: the agent you put here does this part of the job and passes the result on',
    filter: 'sorts by task type (code, research or everything else) and sends each type down its own belt',
    merger: 'lets several belts share one; nothing waits and nothing is combined, each job goes on alone',
    splitter: 'one belt into several. With a JOINER after the branches every branch gets a copy; without one, jobs take turns',
    joiner: 'waits until every branch has finished, then sends ONE combined result on',
    loop: 'sends the work back for another pass until the reviewer approves it (or passes run out), then on',
    outbox: 'where the finished result comes out; click it on the live floor to read every result'
  };
  /* HOW EACH MACHINE IS WIRED, drawn (2026-09-27 audit P2): a tiny in→out diagram on every shelf tile, so SPLIT (one in, two
     out), JOINER (two in, a wait bar, one out), MERGER (two in, one out, no bar), FILTER (one in, three typed outs) and LOOP
     (a back arrow) differ at a glance — their sprites are all small grey gadgets. Stroke = currentColor (the theme). */
  const MACHINE_DIAGRAM = {
    intake: '<rect x="2" y="6" width="10" height="12"/><path d="M12 12H32"/><path class="md-fill" d="M32 9L36 12L32 15z"/>',
    bay: '<path d="M1 12H9"/><path class="md-fill" d="M9 9L13 12L9 15z"/><rect x="14" y="6" width="11" height="12"/><path d="M25 12H32"/><path class="md-fill" d="M32 9L36 12L32 15z"/>',
    outbox: '<path d="M2 12H21"/><path class="md-fill" d="M21 9L25 12L21 15z"/><rect x="27" y="6" width="10" height="12"/>',
    splitter: '<path d="M2 12H12"/><path d="M12 12V5H29"/><path class="md-fill" d="M29 2L33 5L29 8z"/><path d="M12 12V19H29"/><path class="md-fill" d="M29 16L33 19L29 22z"/>',
    joiner: '<path d="M2 5H12V12"/><path d="M2 19H12V12"/><rect class="md-fill" x="13" y="6" width="3" height="12"/><path d="M16 12H30"/><path class="md-fill" d="M30 9L34 12L30 15z"/>',
    merger: '<path d="M2 5H14V12"/><path d="M2 19H14V12"/><path d="M14 12H30"/><path class="md-fill" d="M30 9L34 12L30 15z"/>',
    filter: '<path d="M2 12H11"/><path d="M11 12V4H29"/><path class="md-fill" d="M29 1L33 4L29 7z"/><path d="M11 12H29"/><path class="md-fill" d="M29 9L33 12L29 15z"/><path d="M11 12V20H29"/><path class="md-fill" d="M29 17L33 20L29 23z"/>',
    loop: '<path d="M2 18H30"/><path class="md-fill" d="M30 15L34 18L30 21z"/><path d="M25 18V6H10V12"/><path class="md-fill" d="M7 12L10 16L13 12z"/>'
  };
  const machineDiagramSVG = id => MACHINE_DIAGRAM[id] ? '<svg class="refit-machinediagram" viewBox="0 0 40 24" aria-hidden="true" focusable="false">' + MACHINE_DIAGRAM[id] + '</svg>' : '';
  // the shelf in the order work meets them, in three plain groups (a junction goes ON a belt)
  const MACHINE_GROUPS = [
    ['THE LINE', 'work comes in, agents do the steps, the result comes out', ['bay', 'intake', 'outbox']],
    ['BRANCH & COMBINE', 'drop these ON a belt', ['splitter', 'merger', 'joiner', 'filter']],
    ['REPEAT', 'a reviewer can send work back', ['loop']]
  ];
  /* THE MACHINES SHELF (2026-09-23 playtest fix). The Conveyors tab offered whole LINES and the BELT tool,
     but no single machine: INBOX, BAY, OUTBOX and every junction were reachable only by typing into the
     Props search. The shelf is computed from the catalog (every cat:'workflow' entry — a machine added
     there shows up here with no second list), ordered the way work flows through them, each with its
     live art and its one-line purpose (PALETTE_PURPOSE). A pick arms the ordinary PROP placement for
     that machine while the Conveyors tab stays up. */
  const MACHINES_LABEL = 'MACHINES';   // the Conveyors tab's single-machine shelf — the guide + Field Manual name it by this
  const LINES_LABEL = 'LINES';         // …and its ready-made lines, the section key beside it
  let convSection = 'lines';           // the Conveyors section up now: 'lines' (BUILD YOUR OWN + the ready-made shelf) or 'machines'
  const MACHINE_ORDER = ['bay', 'intake', 'outbox', 'splitter', 'merger', 'joiner', 'filter', 'loop'];   // (org P18) the HOTBAR's order (keys 1–8), so the shelf and the hand agree; JOINER still beside MERGER
  function workflowMachines() {
    const all = catalog().filter(c => c && c.cat === 'workflow');
    const rank = id => { const i = MACHINE_ORDER.indexOf(id); return i < 0 ? MACHINE_ORDER.length : i; };
    return all.slice().sort((a, b) => rank(a.id) - rank(b.id));
  }
  function machinePalette() {
    const wrap = document.createElement('div'); wrap.className = 'refit-machines';
    const ms = workflowMachines();
    // grouped the way work meets them (every catalog machine lands in a group; an unknown one joins the last)
    const groupOf = id => { const g = MACHINE_GROUPS.findIndex(x => x[2].indexOf(id) >= 0); return g < 0 ? MACHINE_GROUPS.length - 1 : g; };
    let grid = null, curGroup = -1;
    for (const c of ms) {
      const gi = groupOf(c.id);
      if (gi !== curGroup) {
        curGroup = gi;
        const gh = document.createElement('div'); gh.className = 'refit-machinegroup';
        gh.textContent = MACHINE_GROUPS[gi][0];   // the group's name only (its how-to line rides each tile's tip)
        wrap.appendChild(gh);
        grid = document.createElement('div'); grid.className = 'refit-machinegrid'; grid.setAttribute('aria-label', MACHINE_GROUPS[gi][0] + ' machines');
        wrap.appendChild(grid);
      }
      const b = document.createElement('button'); b.type = 'button';
      const on = (tool === 'prop' && propType === c.id) || (!!hand && hand.t === c.id);
      b.className = 'refit-machinetile' + (on ? ' active' : ''); b.dataset.machine = c.id; b.dataset.prop = c.id;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const purpose = PALETTE_PURPOSE[c.id] || '', how = MACHINE_GROUPS[gi][1] || '';
      /* THE TILE IS THE PROPS TAB'S TILE (2026-09-30): the machine's own art, big, its name, and its wiring drawn small under it.
         The sentence that used to sit under the name is the tile's hover tip (the station tooltip) and its accessible
         description, with its group's how-to ("drop these ON a belt") beside it. */
      b.setAttribute('aria-label', c.label);
      b.setAttribute('aria-description', purpose + (how ? ' — ' + how : ''));
      b.dataset.tip = c.label + (purpose ? '\n' + purpose : '') + (how ? '\n' + how : '');
      const DW = 76, DH = 50, SS = Math.max(2, Math.min(3, window.devicePixelRatio || 1)), PAD = 3;   // the prop tile's art well; a tight halo so a small machine still fills it
      const cvEl = document.createElement('canvas'); cvEl.className = 'refit-machinetile-cv';
      cvEl.style.width = DW + 'px'; cvEl.style.height = DH + 'px'; cvEl.width = Math.round(DW * SS); cvEl.height = Math.round(DH * SS);
      const tile = (typeof PropSprites !== 'undefined') ? PropSprites.TILE : 12;
      const nativeW = c.w * tile + PAD * 2, nativeH = c.h * tile + PAD * 2;
      const density = typeof PropRemaster !== 'undefined' && PropRemaster.isProjection() ? 4 : 1;
      const off = document.createElement('canvas'); off.width = nativeW * density; off.height = nativeH * density;
      propThumbs.push({ id: c.id, w: c.w, h: c.h, off, octx: off.getContext('2d'), dctx: cvEl.getContext('2d'), nativeW, nativeH, density, bw: cvEl.width, bh: cvEl.height, pad: PAD });
      const nm = document.createElement('span'); nm.className = 'refit-machinetile-nm'; nm.textContent = c.label;
      b.append(cvEl, nm);
      if (MACHINE_DIAGRAM[c.id]) b.insertAdjacentHTML('beforeend', machineDiagramSVG(c.id));
      b.onclick = () => {
        // a shelf pick puts the machine IN HAND — the hotbar's own hand (THE HAND, 2026-10-10), never a second placement mode
        propType = c.id;
        setHand({ t: c.id }, { silent: true });
        root.querySelectorAll('.refit-linetile.active').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-pressed', 'false'); });
        hidePropCard(); setHint(); sfx('click');
      };
      b.onmouseenter = () => { hoverThumb = c.id; };
      b.onmouseleave = () => { hoverThumb = null; };
      grid.appendChild(b);
    }
    try { paintThumbs(performance.now(), true); } catch (e) {}   // paint once; the frame loop animates the armed/hovered one
    return wrap;
  }
  const THUMB_PAD = 7;   // native-px halo so art that overflows the footprint (monitors, masts, shadows) isn't clipped
  /* A MACHINE'S OWN FLOOR ART, AS A STILL (2026-09-30). The Workflow panel's line diagram shows every part as the machine it is
     on the floor: the same PropSprites draw the MACHINES shelf tiles and the selected-prop preview use, rendered once per
     machine at the art's own density and kept as a data URL (an <img> survives the diagram's repaints; a canvas would not).
     One still per machine, re-made when the remaster's revision moves (a still made before the authored art finished
     loading is made again after). */
  const STILL_PAD = 4;
  const machineStills = {};
  function machineStill(type) {
    if (typeof PropSprites === 'undefined' || typeof document === 'undefined') return '';
    const remaster = typeof PropRemaster !== 'undefined' ? PropRemaster : null;
    const density = remaster && remaster.isProjection() ? 4 : 1;
    const key = type + '@' + density, rev = remaster && remaster.revision ? remaster.revision() : 0;
    const had = machineStills[key];
    if (had && had.rev === rev) return had.url;
    let url = '';
    try {
      const c = catalog().find(x => x && x.id === type);
      if (c) {
        const tile = PropSprites.TILE || 12, nativeW = c.w * tile + STILL_PAD * 2, nativeH = c.h * tile + STILL_PAD * 2;
        const px = density > 1 ? density : 3;   // pixel-native art is drawn 3x, so the card's 36px image stays crisp
        const off = document.createElement('canvas'); off.width = nativeW * px; off.height = nativeH * px;
        const o = off.getContext('2d');
        o.scale(px, px); o.imageSmoothingEnabled = false; o.translate(STILL_PAD, STILL_PAD);
        PropSprites.setCtx(o); PropSprites.setNow(0);
        PropSprites.draw({ t: c.id, x: 0, y: 0, w: c.w, h: c.h }, true);
        url = off.toDataURL('image/png');
      }
    } catch (e) { url = ''; /* no art: the diagram shows the part by name alone */ }
    finally { if (ctx) PropSprites.setCtx(ctx); }   // the sprite module's draw context goes back to the floor's own canvas
    machineStills[key] = { rev, url };
    return url;
  }
  function setLibraryPlacement(placing) {
    tool = placing ? 'prop' : 'select';
    root.dataset.tool = tool; hideTip(); setCursor();
    root.querySelectorAll('.refit-tool').forEach(b => {
      const active = b.dataset.tool === tool;
      b.classList.toggle('active',active); b.setAttribute('aria-pressed',String(active));
    });
    setHint();
  }
  /* ---------- THE HAND (2026-10-10 — Andrew: "fully polish and integrate this into starnet", from his build-mode prototype) ----------
     Building a line is DRAGGING now, the way the prototype (scratchpad proto/build-mode-proto.html) feels: drag a machine and a belt
     follows the pointer to wherever you let go; drag the middle of a belt and it branches; let go on empty floor and the dock offers
     the pieces that fit there. What you HOLD is a sub-state of SELECT — never an eleventh tool: `hand` is the piece the next click
     places, picked from the Conveyors tab's HOTBAR (keys 1–8 while that tab is up), the MACHINES shelf, or Q — the pipette, which
     picks up one like the piece under the pointer, its settings and its crew with it. Right-click or Esc puts it down. Empty-handed,
     right-click removes the conveyor piece (or the whole belt) under the pointer — one undo, and the floor says UNDID · <WHAT> where
     it happened. Touch has no right-click, R, Q or Alt: the dock keys under the hotbar do each of them. */
  const HOTBAR = ['bay', 'intake', 'outbox', 'splitter', 'merger', 'joiner', 'filter', 'loop'];
  let hand = null;          // { t, cfg?, agentId?, role?, brief?, hands?, r?, m? } — the piece the next click places (null = an empty hand)
  let touchArm = null;      // 'remove' | 'pipette' — a dock key armed the next tap (touch has no right-click and no Q)
  let flipPref = false;     // R mid-drag (or the CORNER key): where two shortest routes exist, the belt's corner turns the other way
  let altHeld = false, altLatched = false;   // Alt held (or the ALT VIEW key latched): every setting, SEND TO and stage count shows
  let dropPick = null;      // an empty-floor release waiting on PICK WHAT GOES HERE: { from, tile, flip, path, opts:[{t,ok,msg}] }
  // held Alt shows in every tab; the ALT VIEW key's latch only in the Conveyors tab, where that key (its off switch) is on screen —
  // latched, then Props, it painted every line outline and junction plate over the furnishing with no visible way off (wave 2, build-11)
  const altOn = () => altHeld || (altLatched && buildGroup === 'workflow');
  const placingProp = () => tool === 'prop' || !!hand;   // a piece is in hand — through the PROP tool or the hotbar
  const HAND_CFG_KEYS = ['maxIter', 'when', 'timeoutMin', 'bufferSize', 'divide', 'text'];   // 'text' = a SIGN's own words ride along with a copy
  // an agent this station crews (a pipette or a copy may carry only these — an id from elsewhere is dropped)
  const agentHere = aid => !!aid && (((opts && typeof opts.agents === 'function' && opts.agents()) || []).some(a => a && a.id === aid));
  // what the pipette picks up: the type, its settings (passes, verdict, wait), its facing, and for a BAY its crew, role and brief
  function handFromProp(p) {
    const h = { t: p.t };
    const cfg = {};
    for (const k of HAND_CFG_KEYS) if (p[k] != null) cfg[k] = p[k];
    if (Object.keys(cfg).length) h.cfg = cfg;
    if (p.t === 'bay') {
      if (agentHere(p.agentId)) h.agentId = p.agentId;
      if (p.role) h.role = p.role;
      if (p.brief) h.brief = p.brief;
      if (p.hands) h.hands = p.hands;
    }
    if (p.r) h.r = p.r;
    if (p.m) h.m = 1;
    return h;
  }
  /* UNDO / REDO keep THE HAND (final floor lane M21 / R55): only PICK WHAT GOES HERE closes — its options were probed against the
     floor before the undo; the held piece and an armed REMOVE / PICK UP stay (the hand ghost re-judges on geoVer anyway) */
  const dropPickOff = () => { if (dropPick) { dropPick = null; renderSelection(); setHint(); } };
  function setHand(h, o) {
    const next = h && h.t ? h : null;
    if (next && tool !== 'select') selectTool('select', { silent: true, keepKit: true, keepGroup: true });
    hand = next; touchArm = null; dropPick = null;
    if (next) {
      propType = next.t;
      propRot = next.r != null && canTurn(next.t) ? (next.r & 3) : 0;
      propMir = next.m && canFlip(next.t) ? 1 : 0;
      if (selectedPropId || groupIds.length || selBelts) { selectedPropId = null; groupIds = []; selBelts = null; }
    }
    propHoverMemo = null;
    if (root) { root.dataset.hand = next ? next.t : ''; paintHandKeys(); renderSelection(); }
    hideTip(); setHint(); setCursor();
    if (!(o && o.silent)) sfx('click');
  }
  const toggleHand = t => setHand(hand && hand.t === t && !hand.agentId && !hand.cfg ? null : { t });
  /* NEW LINE = AN INBOX IN HAND (Andrew 2026-10-13). BUILD YOUR OWN LINE used to lay INBOX → BAY → OUTBOX itself, near the middle of
     the view; now nothing lands until the Commander clicks: the INBOX rides the pointer as the hand's ghost, a click on clear floor
     places it THERE (commitPropStamp), and Esc / right-click puts it down with nothing placed. `newLine` marks it one-shot: once it
     lands the hand empties, so the next drag FROM the INBOX lays its belt and letting go on clear floor offers the next piece (PICK
     WHAT GOES HERE) — the hand's own way to grow a line, nothing laid for them. */
  function startNewLine() {
    setHand({ t: 'intake', newLine: true });
    hidePropCard();
  }
  // THE HOTBAR: the conveyor pieces, art + name (the sentence is the hover tip — no sentences under tiles), its key in the corner
  function hotbarEl() {
    const wrap = document.createElement('div'); wrap.className = 'refit-hotbar-wrap';
    const bar = document.createElement('div'); bar.className = 'refit-hotbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Conveyor pieces');
    HOTBAR.forEach((t, i) => {
      const c = catalog().find(x => x && x.id === t); if (!c) return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'refit-hotslot' + (hand && hand.t === t ? ' active' : ''); b.dataset.hot = t;
      b.setAttribute('aria-pressed', String(!!hand && hand.t === t));
      b.setAttribute('aria-label', c.label + ' (' + (i + 1) + ')');
      b.dataset.tip = c.label + ' · key ' + (i + 1) + (PALETTE_PURPOSE[t] ? '\n' + PALETTE_PURPOSE[t] : '') + (JUNCTION_TAG_TYPES[t] ? '\nclick a belt to put it on that line' : '');
      const k = document.createElement('span'); k.className = 'refit-hotkey'; k.textContent = String(i + 1);
      const img = document.createElement('img'); img.alt = ''; img.className = 'refit-hotart'; const url = machineStill(t); if (url) img.src = url;
      const nm = document.createElement('span'); nm.className = 'refit-hotname'; nm.textContent = c.label;
      b.append(k, img, nm);
      b.onclick = () => { toggleHand(t); };
      bar.appendChild(b);
    });
    // the gestures a mouse has and a finger does not, as keys (each one wears the key that does it)
    const keys = document.createElement('div'); keys.className = 'refit-handkeys'; keys.setAttribute('aria-label', 'Hand keys');
    const key = (id, label, kbd, tipText, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'refit-handkey'; b.dataset.handkey = id;
      b.innerHTML = '<span>' + esc(label) + '</span><kbd>' + esc(kbd) + '</kbd>';
      b.dataset.tip = tipText; b.onclick = fn; keys.appendChild(b);
      const on = { remove: touchArm === 'remove', pipette: touchArm === 'pipette', corner: flipPref, alt: altLatched }[id];
      b.classList.toggle('active', !!on); b.setAttribute('aria-pressed', String(!!on));
    };
    /* REMOVE / PICK UP arm the next tap in SELECT — the only tool that reads touchArm. Under an armed LINES / PROP tool the key lit
       and the next tap stamped or inspected through that tool instead (wave 2, build-09): go back to SELECT first (it clears
       touchArm, so the toggle is read before), keeping the Conveyors tab and the library where they are */
    const armTouch = id => {
      const on = touchArm !== id;
      if (tool !== 'select') selectTool('select', { silent: true, keepKit: true, keepGroup: true });
      setHand(null, { silent: true }); touchArm = on ? id : null; paintHandKeys(); setHint(); setCursor(); sfx('click');
    };
    key('remove', 'REMOVE', 'R-CLICK', 'Tap a piece or a belt to remove it (a mouse: right-click it) · UNDO puts it back', () => armTouch('remove'));
    key('pipette', 'PICK UP', 'Q', 'Tap a piece to hold one like it — its settings and crew too (a mouse: point at it and press Q)', () => armTouch('pipette'));
    key('corner', 'CORNER', 'R', 'Flip which way a dragged belt turns its corner (a mouse: press R while dragging)', () => { flipPref = !flipPref; handPvKey = ''; paintHandKeys(); sfx('click'); });
    key('alt', 'ALT VIEW', 'ALT', 'Show every setting, every SEND TO and every line’s stage count on the floor (a mouse: hold Alt)', () => { altLatched = !altLatched; paintHandKeys(); sfx('click'); });
    if (lastCopy && lastCopy.type === 'lines') key('paste', 'PASTE', 'Ctrl+V', 'Pick up the last copy again: ' + lastCopy.label, () => holdClip(lastCopy, orientEv()));
    wrap.append(bar, keys);
    return wrap;
  }
  // the lit state of the hotbar slots + the hand keys, without rebuilding them (a rebuild would drop the pointer's hover)
  function paintHandKeys() {
    if (!root) return;
    root.querySelectorAll('.refit-hotslot').forEach(b => { const on = !!hand && b.dataset.hot === hand.t; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    root.querySelectorAll('.refit-ownline').forEach(b => { const on = !!(hand && hand.newLine); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    root.querySelectorAll('.refit-machinetile').forEach(b => { const on = (!!hand && b.dataset.machine === hand.t) || (tool === 'prop' && propType === b.dataset.machine); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    const lit = { remove: touchArm === 'remove', pipette: touchArm === 'pipette', corner: flipPref, alt: altLatched };
    root.querySelectorAll('.refit-handkey').forEach(b => { const on = !!lit[b.dataset.handkey]; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  }
  function propTile(c, core = false) {
    const b = document.createElement('button');
    b.type = 'button';
    const selected = tool === 'prop' && (c.id === propType || (core && capOf(c) === WorldModel.capForProp(propType)));
    b.className = 'refit-proptile' + (sectionOf(c) !== 'decoration' ? ' fn' : '') + (core ? ' refit-core-card' : '') + (selected ? ' active' : '');
    b.dataset.prop = c.id;   // lets the tutorial light a specific gear tile by id
    b.dataset.purpose = sectionOf(c);
    if (core) b.dataset.coreAbility = capOf(c);
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(c.id) : null;
    // A brief shared tooltip identifies the item without selecting it or opening a card.
    // Full details remain in the inspector; no native browser title bubble.
    const purpose = PALETTE_PURPOSE[c.id] || '';
    const glance = purpose || EquipmentHelp.PURPOSE[capOf(c)] || '';
    b.setAttribute('data-tip', c.label + ' · ' + EquipmentHelp.label(c, capOf(c)) + (glance ? '\n' + glance : ''));
    b.setAttribute('aria-description', c.label + ' · ' + c.w + '×' + c.h + (grant ? ' · grants ' + grant : '') + (purpose ? ' — ' + purpose : ''));
    // Grid-only re-render: a full renderPalette() here would rebuild the search field and steal focus
    // out of it mid-search. But a pick out of a SEARCH result does change tab state — the prop almost
    // always lives under a different tier/category than the one still selected behind the results. Move
    // the tabs to the prop's own drawer NOW (silently, no re-render) so that whenever the search is
    // cleared the palette opens on the shelf holding what you actually armed, with the tile lit. Without
    // this, clearing dropped you back on WORKSTATIONS with nothing selected while a beanbag was armed.
    b.onclick = () => {
      propType = c.id;
      setLibraryPlacement(true);
      if (isSearching()) { propTier = c.tier || 'cosmetic'; propCat = 'all'; propSection = sectionOf(c); propAbility = ''; }
      // Keep scroll and keyboard focus in the inventory; choosing an item must not
      // recreate 144 canvases or throw the user back to the top of the shelf.
      root.querySelectorAll('.refit-proptile').forEach(tile => {
        const active = tile.dataset.prop === propType || (tile.dataset.coreAbility && tile.dataset.coreAbility === WorldModel.capForProp(propType));
        tile.classList.toggle('active', active); tile.setAttribute('aria-pressed', String(active));
      });
      renderPropPreview(); renderEquipmentInfo(); setHint(); paintMakeStatus();   // MAKE SIDE VIEW follows the armed prop
      if (window.matchMedia('(max-width: 700px)').matches) fitCamera();
      sfx('click');
    };
    b.onmouseenter = () => { hoverThumb = c.id; };
    b.onmouseleave = () => { hoverThumb = null; };

    const DW = 76, DH = 50, SS = Math.max(2, Math.min(3, window.devicePixelRatio || 1));  // supersample so even wide props stay crisp
    const cvEl = document.createElement('canvas');
    cvEl.className = 'refit-proptile-cv';
    cvEl.style.width = DW + 'px'; cvEl.style.height = DH + 'px';
    cvEl.width = Math.round(DW * SS); cvEl.height = Math.round(DH * SS);

    const tile = (typeof PropSprites !== 'undefined') ? PropSprites.TILE : 12;
    const nativeW = c.w * tile + THUMB_PAD * 2, nativeH = c.h * tile + THUMB_PAD * 2;
    const density=typeof PropRemaster!=='undefined'&&PropRemaster.isProjection()?4:1;
    const off = document.createElement('canvas'); off.width = nativeW*density; off.height = nativeH*density;

    const lbl = document.createElement('span'); lbl.className = 'refit-proptile-lbl'; lbl.textContent = core ? 'ABILITY · ' + abilityName(capOf(c)) : c.label;
    b.appendChild(cvEl); b.appendChild(lbl);
    const size = document.createElement('span'); size.className = 'refit-proptile-size'; size.textContent = core ? c.label : c.w + ' × ' + c.h + ' tiles'; b.appendChild(size);
    const badge = document.createElement('span'); badge.className = 'refit-proptile-grant';
    const icon = document.createElement('canvas'); icon.width = icon.height = 24; icon.className = 'refit-purpose-icon'; icon.setAttribute('aria-hidden', 'true');
    badge.appendChild(icon); badge.append(document.createTextNode(core ? 'ABILITY' : EquipmentHelp.label(c, capOf(c)))); b.appendChild(badge);
    paintIcon(icon, sectionOf(c) === 'abilities' ? 'prop' : sectionOf(c) === 'equipment' ? 'line' : 'paint', iconColour(root.querySelector('[data-tool="prop"]')));
    if (core) { const status = document.createElement('span'); status.className = 'refit-core-status'; status.textContent = 'CHECKING ACCESS'; b.appendChild(status); }
    // (the old '○' walkable marker is gone — playtesting showed it read as an unexplained mystery badge;
    //  the hover card already states "N×M · walkable", which is where that fact is actually legible)
    propThumbs.push({ id: c.id, w: c.w, h: c.h, off, octx: off.getContext('2d'), dctx: cvEl.getContext('2d'),
                      nativeW, nativeH, density, bw: cvEl.width, bh: cvEl.height });
    return b;
  }
  // One static, truthful preview per selection/orientation change. The gallery already owns
  // animated thumbnails; this larger inspection well adds no frame-loop work.
  function renderPropPreview() {
    const host = root && root.querySelector('#refit-selected-prop');
    const c = catalog().find(c => c.id === propType);
    if (!host || !c) return;
    const r = propFacing(c.id), m = propFlipOn(c.id), box = propBox(c.id, r), grant = grantLabelOf(c);
    const previewKey = [c.id,r,m].join('|'); if (host.dataset.previewKey === previewKey) return; host.dataset.previewKey = previewKey;
    host.innerHTML = '<div class="refit-preview-art"><canvas width="280" height="180" aria-label="' + esc(c.label) + ' preview"></canvas></div>' +
      '<div class="refit-preview-info"><b>' + esc(c.label) + '</b>' +
      '<span>' + box.w + ' × ' + box.h + ' tiles · ' + FACE_WORD[r] + (m ? ' · flipped' : '') + '</span>' +
      '<span class="refit-preview-grant">' + esc(EquipmentHelp.label(c, capOf(c))) + '</span>' +
      '<div class="refit-preview-actions">' +
      (canTurn(c.id) ? '<button class="bb xs" type="button" data-preview-turn>↻ TURN · R</button>' : '') +
      (canFlip(c.id) ? '<button class="bb xs" type="button" data-preview-flip>⇆ FLIP · M</button>' : '') + '</div></div>' +
      '<span class="refit-placement-note">Click a clear spot on the station · Esc cancels</span>';
    const alternatives = capOf(c) && capOf(c) !== 'computer' ? catalog().filter(p => capOf(p) === capOf(c)) : [];
    const more = root.querySelector('.refit-prop-more');
    more?.querySelector('.refit-designs')?.remove();
    if (alternatives.length > 1) {
      const designs = document.createElement('button'); designs.className = 'bb xs refit-designs'; designs.type = 'button';
      designs.textContent = 'OTHER DESIGNS · ' + alternatives.length; designs.setAttribute('aria-label', 'Choose another design for ' + abilityName(capOf(c)));
      designs.onclick = () => chooseAbility(capOf(c), true); if (more) more.prepend(designs);
    }
    const nativeW = box.w * 12 + 24, nativeH = box.h * 12 + 24;
    const density=typeof PropRemaster!=='undefined'&&PropRemaster.isProjection()?6:1;
    const off = document.createElement('canvas'); off.width = nativeW*density; off.height = nativeH*density;
    const o = off.getContext('2d'); o.scale(density,density);o.translate(12, 12); o.imageSmoothingEnabled = true;
    PropSprites.setCtx(o); PropSprites.setNow(0);
    PropSprites.draw({ t: c.id, x: 0, y: 0, w: box.w, h: box.h, r, m }, false);
    const cv = host.querySelector('canvas'), d = cv.getContext('2d'); d.imageSmoothingEnabled = true;d.imageSmoothingQuality='high';
    const scale = Math.min(cv.width / nativeW, cv.height / nativeH);
    const w = Math.round(nativeW * scale), h = Math.round(nativeH * scale);
    d.drawImage(off, Math.round((cv.width - w) / 2), Math.round((cv.height - h) / 2), w, h);
    const turn = host.querySelector('[data-preview-turn]'), flip = host.querySelector('[data-preview-flip]');
    if (turn) turn.onclick = () => { propRot = nextFace(c.id, propRot, 1) & 3; renderPropPreview(); renderEquipmentInfo(); setHint(); sfx('click'); };
    if (flip) flip.onclick = () => { propMir = propMir ? 0 : 1; renderPropPreview(); renderEquipmentInfo(); setHint(); sfx('click'); };
  }
  // draw every visible preview tile for time `now` (animated). Renders native → fit-blits with nearest-neighbour.
  function paintThumbs(now, all) {
    if (typeof PropSprites === 'undefined' || !propThumbs.length) return;
    for (const th of propThumbs) {
      if (!all && th.id !== propType && th.id !== hoverThumb) continue;
      const o = th.octx;
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.clearRect(0, 0, th.off.width, th.off.height);
      o.scale(th.density||1,th.density||1);
      o.imageSmoothingEnabled = false;
      o.translate(th.pad != null ? th.pad : THUMB_PAD, th.pad != null ? th.pad : THUMB_PAD);
      PropSprites.setCtx(o); PropSprites.setNow(now);
      PropSprites.draw({ t: th.id, x: 0, y: 0, w: th.w, h: th.h }, true);   // work=true → screens read alive in the preview
      const d = th.dctx, s = Math.min(th.bw / th.nativeW, th.bh / th.nativeH);
      const dw = Math.round(th.nativeW * s), dh = Math.round(th.nativeH * s);
      d.setTransform(1, 0, 0, 1, 0, 0);
      d.clearRect(0, 0, th.bw, th.bh);
      d.imageSmoothingEnabled = (th.density||1)>1;d.imageSmoothingQuality='high';
      d.drawImage(th.off, Math.round((th.bw - dw) / 2), Math.round((th.bh - dh) / 2), dw, dh);
    }
  }

  const SWATCH_TILE = 12;   // the bake's own tile size — samples are drawn 1:1, never scaled

  /* the hue a DECK material's chip previews in. The SELECTED material previews in the hue that is
     actually selected: anything else lets a chip promise a look the deck won't deliver once you
     override its suggested tone (pick PLANK, then COBALT, and a walnut chip is now a lie). An
     UNSELECTED material previews in its own suggested tone, which stays honest because clicking it
     MOVES the hue there — the chip is showing you what that click produces. */
  function styleBaseFor(mid) {
    const def = station.FLOOR_MATERIALS && station.FLOOR_MATERIALS[mid];
    const sid = (mid !== mat && def && def.suggest && station.FLOOR_STYLES[def.suggest]) ? def.suggest : style;
    return (station.FLOOR_STYLES[sid] || station.FLOOR_STYLES.hull).base;
  }
  /* the material chip is rendered by the REAL bake (StationBake.sampleMaterial paints through the
     same per-tile painters the station uses), so a deck preview can never promise a look the
     station won't deliver. Falls back to the flat colour chip if the bake module isn't loaded. */
  function matSwatchCanvas(mid, base, cols, rows) {
    const w = (cols || 4) * SWATCH_TILE, h = (rows || 2) * SWATCH_TILE;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    x.fillStyle = base; x.fillRect(0, 0, w, h);
    try { if (typeof StationBake !== 'undefined' && StationBake.sampleMaterial) StationBake.sampleMaterial(x, mid, base, cols || 4, rows || 2, SWATCH_TILE); }
    catch (e) { /* a swatch must never break the palette */ }
    return c;
  }

  // the hue a WALL chip previews in — same honesty rule as styleBaseFor. AUTO has no hue of its
  // own, so it borrows the currently selected deck colour, which is exactly what "match the deck"
  // will produce.
  function wallBaseFor(mid) {
    const def = station.WALL_MATERIALS && station.WALL_MATERIALS[mid];
    if (wallStyle !== 'follow' && station.FLOOR_STYLES[wallStyle]) return station.FLOOR_STYLES[wallStyle].base;
    const sid = (mid !== wallMat && def && def.suggest && station.FLOOR_STYLES[def.suggest]) ? def.suggest : style;
    return (station.FLOOR_STYLES[sid] || station.FLOOR_STYLES.hull).base;
  }
  /* the hue a SHELL chip previews in. Distinct from wallBaseFor in one way that matters: AUTO here
     resolves to the MATERIAL's own suggested tone, and for STATION that suggestion is null — which
     is not a missing value but the shell's own grey, and the bake must be told null to paint it. */
  function hullAutoBase(mid) {
    const def = station.HULL_MATERIALS && station.HULL_MATERIALS[mid];
    const sid = def && def.suggest;
    return (sid && station.FLOOR_STYLES[sid]) ? station.FLOOR_STYLES[sid].base : null;
  }
  function hullBaseFor(mid) {
    if (hullStyle !== 'follow' && station.FLOOR_STYLES[hullStyle]) return station.FLOOR_STYLES[hullStyle].base;
    return hullAutoBase(mid);
  }
  // same contract as the other two: painted by the REAL hull recipes. A shell chip shows the plate
  // ring AND the skirt below it, because those are two different surfaces of one material and a
  // preview of only the ring can't tell TIMBER from CLAPBOARD (see the sampleHull note).
  function hullSwatchCanvas(mid, base, cols, height) {
    const w = (cols || 4) * SWATCH_TILE, h = height || 32;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    const b = base === undefined ? hullBaseFor(mid) : base;
    x.fillStyle = b || '#191712'; x.fillRect(0, 0, w, h);
    try { if (typeof StationBake !== 'undefined' && StationBake.sampleHull) StationBake.sampleHull(x, mid, b, cols || 4, h, SWATCH_TILE); }
    catch (e) { /* a swatch must never break the palette */ }
    return c;
  }

  // same contract as matSwatchCanvas: painted by the REAL wall recipes, never a hand-drawn mock
  function wallSwatchCanvas(mid, base, cols, height) {
    const w = (cols || 4) * SWATCH_TILE, h = height || 26;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    const b = base || wallBaseFor(mid);
    x.fillStyle = b; x.fillRect(0, 0, w, h);
    try { if (typeof StationBake !== 'undefined' && StationBake.sampleWall) StationBake.sampleWall(x, mid, b, cols || 4, h, SWATCH_TILE); }
    catch (e) { /* a swatch must never break the palette */ }
    return c;
  }

  /* ---------- STARTER LINES (blueprints): palette schematics + ghost + stamp ----------
     The catalog lives in WorldModel.BLUEPRINTS (pure, headless-tested); everything here is
     presentation + the same ghost/commit shape every other tool uses. */
  const blueprints = () => (typeof WorldModel !== 'undefined' && WorldModel.BLUEPRINTS) || [];
  const blueprintOf = id => { for (const b of blueprints()) if (b.id === id) return b; return null; };
  // stamp centered under the cursor (a 17-tile line hung off the click point reads as a misfire)
  const lineOrigin = (bp, tx, ty) => ({ x: tx - (bp.w >> 1), y: ty - (bp.h >> 1) });
  // one-line purposes for the shelf cards — what each line DOES, in station voice
  /* PLAIN DESCRIPTIONS (2026-09-30 — "the simplest friendliest UI possible, no confusion"): a line's tip says what it does in
     everyday words — no lanes, gates or doors */
  const LINE_PURPOSE = {
    front_desk: 'one agent does each job, start to finish',
    research_line: 'one agent digs up sources, the next writes the answer',
    revision_loop: 'one agent drafts, a reviewer sends it back until it is right',
    sorting_office: 'sends each request to the right specialist, by what it is about',
    triage_desk: 'coding, research and everything else each go to their own specialist',
    parallel_crew: 'each job goes to the next of three agents, and every result ships',
    swarm_synthesis: 'three agents research the same job, one writes the answer',
    second_opinion: 'two agents take the same job, and their answers are combined into one',
    ship_out: 'no INBOX: whatever this agent finishes lands in the OUTBOX',
    assembly_line: 'four agents in a row, each building on the last',
    build_test: 'a builder makes it, a tester sends it back until it passes',
    code_foundry: 'coding requests are built and reviewed until they pass; anything else goes to another agent',
    gauntlet: 'two agents take the job, one combines their answers, and a reviewer checks it',
    crucible: 'two reviewers in a row: the work has to pass both',
    mission_control: 'sorts requests three ways, works each in two steps, and ships them all from one place',
    deep_dive: 'three researchers dig, one writes it up, and a reviewer checks it',
    allowance_desk: 'one agent, and the line can never spend more than $5 a day',
    two_doors: 'two ways in (say, a schedule and a chat app), one agent does the work',
    load_balancer: 'jobs take turns between two agents',
    fire_escape: 'if the reviewer still is not happy after its tries, a fixer takes over',
  };
  /* PLAIN NAMES + KIND OF WORK (2026-09-28): each shelf line carries them in the catalog itself (WorldModel.BLUEPRINTS
     .plain / .work), so the shelf, the agent's station builder and the tests read one source. */
  const LINE_PLAIN = {}, LINE_WORK = {};
  for (const bp of ((typeof WorldModel !== 'undefined' && WorldModel.BLUEPRINTS) || [])) { if (bp.plain) LINE_PLAIN[bp.id] = bp.plain; if (bp.work) LINE_WORK[bp.id] = bp.work; }
  const LINE_WORK_GROUPS = [
    { id: 'any', label: 'ANY JOB', blurb: 'one agent takes the work door to door' },
    { id: 'write', label: 'WRITING & CONTENT', blurb: 'a draft, and a reviewer who can send it back' },
    { id: 'code', label: 'BUILDING SOFTWARE', blurb: 'a builder makes the change, and it is checked before it ships' },
    { id: 'research', label: 'RESEARCH', blurb: 'dig up sources, then write it up' },
    { id: 'volume', label: 'LOTS OF REQUESTS', blurb: 'sort the incoming work, or share it across agents' },
    { id: 'decide', label: 'DECISIONS', blurb: 'more than one take before you decide' },
  ];
  /* SET UP BEFORE YOU PLACE (2026-09-28): the armed card offers the line's daily spending cap (when it has an INBOX) and
     its review tries (when it has a LOOP). Session-scoped per line; stampLine passes them INTO the stamp
     (worldmodel.stampBlueprint opts), so one UNDO still removes the whole line. Defaults are the catalog's own. */
  const LINE_CAPS = [[null, 'No cap'], [1, '$1'], [5, '$5'], [20, '$20']];
  const linePrefs = {};
  function linePrefsOf(bp) {
    const intake = bp.props.find(p => p.t === 'intake'), loop = bp.props.find(p => p.t === 'loop');
    const base = { cap: intake && intake.limits && intake.limits.maxUsdPerDay != null ? intake.limits.maxUsdPerDay : null, tries: loop ? (loop.maxIter || 3) : null };
    return Object.assign(base, linePrefs[bp.id] || {});
  }
  function lineStampOpts(bp) {
    const p = linePrefsOf(bp), o = {};
    if (bp.props.some(x => x.t === 'intake')) o.limits = { maxUsdPerDay: p.cap };
    if (p.tries != null) o.maxIter = p.tries;
    // every step lands with its role's instructions (WorkflowLine.defaultBrief) — part of the same one-undo stamp
    if (typeof WorkflowLine !== 'undefined' && WorkflowLine.defaultBrief) {
      const briefs = {};
      for (const x of bp.props) if (x.t === 'bay' && x.role && !briefs[x.role]) { const d = WorkflowLine.defaultBrief(x.role); if (d) briefs[x.role] = d; }
      if (Object.keys(briefs).length) o.briefs = briefs;
    }
    return o;
  }
  function linePrefsEl(bp) {
    const hasIn = bp.props.some(x => x.t === 'intake'), p = linePrefsOf(bp);
    const el = document.createElement('div'); el.className = 'refit-lineprefs';
    el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Set up ' + (LINE_PLAIN[bp.id] || bp.label) + ' before you place it');
    const row = (label, opts, cur, key) => '<div class="refit-lineprefs-row"><span class="refit-lineprefs-k">' + label + '</span>'
      + opts.map(([v, t]) => '<button type="button" class="bb sm" data-pref="' + key + '" data-val="' + (v == null ? '' : v) + '" aria-pressed="' + (v === cur) + '">' + esc(t) + '</button>').join('') + '</div>';
    el.innerHTML = '<div class="refit-lineprefs-hd">SET UP BEFORE YOU PLACE</div>'
      + (hasIn ? row('DAILY CAP', LINE_CAPS, p.cap, 'cap') : '')
      + (p.tries != null ? row('REVIEW TRIES', [1, 2, 3, 4, 5].map(n => [n, String(n)]), p.tries, 'tries') : '');
    el.querySelectorAll('[data-pref]').forEach(b => b.onclick = ev => {
      ev.stopPropagation();
      const v = b.dataset.val === '' ? null : +b.dataset.val;
      linePrefs[bp.id] = Object.assign({}, linePrefs[bp.id] || {}, { [b.dataset.pref]: v });
      el.replaceWith(linePrefsEl(bp)); sfx('click');
    });
    return el;
  }
  /* schematic v2 — the card draws a MINIATURE of what will stamp, in the floor's own colour
     economy (hex families lifted from propsprites.js RAMP.steel/ACC and conveyor.js's belt bed)
     so the schematic teaches the real floor: the INBOX feeds amber, a BAY is a steel berth with
     the green nameplate pip, the OUTBOX is the dark dispatch chute, a FILTER's out-lanes tint
     like its route tips (cyan coded lane / neutral default), a SPLITTER fans teal. */
  const SCHEME = {
    line: '#06090c',                                                       // universal silhouette outline
    steel: { top: '#3f4b53', face: '#303a41', lit: '#515e67', dk: '#242e35' },  // RAMP.steel, pre-dimmed
    bed: '#161c1a', rail: '#46544c', chev: '#7a8a80',                      // conveyor bed + rails
    amber: '#ffd34a', amberDk: '#caa84a', throat: '#1a1410',               // INBOX feed (ACC.flow family)
    green: '#5ad1b3', greenHot: '#7df0c8',                                 // BAY pip / dispatch family
    chute: '#08130f', chuteBody: '#101614', chuteTop: '#1c2420',           // OUTBOX dark chute
    plate: '#0e1c16',                                                      // bay nameplate inset
    cyan: '#4ad9ff', violet: '#b44aff', violetHot: '#d8b8ff', neutral: '#8a9a90', merge: '#e0a45a',
  };
  const LINE_DIR = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  // follow each junction's out-lanes belt-by-belt so the schematic can tint them — derived from
  // the catalog's belts + routes, never hand-authored per blueprint.
  function traceLanes(bp) {
    const at = {}; for (const b of bp.belts) at[b.x + ',' + b.y] = b;
    const tint = {}, fans = [];
    const paint = (sx, sy, d, col) => {
      let dx = LINE_DIR[d][0], dy = LINE_DIR[d][1], x = sx + dx, y = sy + dy, b = at[x + ',' + y], guard = 0;
      while (b && guard++ < 64) {
        if (!tint[x + ',' + y]) tint[x + ',' + y] = col;
        dx = LINE_DIR[b.d][0]; dy = LINE_DIR[b.d][1]; x += dx; y += dy; b = at[x + ',' + y];
      }
    };
    for (const p of bp.props) {
      if (p.t === 'filter') {
        const dirs = [];
        for (const k of Object.keys(p.routes || {})) { paint(p.x, p.y, p.routes[k], SCHEME.cyan); dirs.push({ d: p.routes[k], col: SCHEME.cyan }); }
        if (p.def) { paint(p.x, p.y, p.def, SCHEME.neutral); dirs.push({ d: p.def, col: SCHEME.neutral }); }
        fans.push({ p, dirs });
      } else if (p.t === 'splitter' || p.t === 'merger' || p.t === 'joiner' || p.t === 'loop') {
        const col = p.t === 'splitter' ? SCHEME.green : p.t === 'loop' ? SCHEME.cyan : SCHEME.merge, dirs = [];
        for (const d of ['N', 'E', 'S', 'W']) {
          const b = at[(p.x + LINE_DIR[d][0]) + ',' + (p.y + LINE_DIR[d][1])];
          if (b && b.d === d) { paint(p.x, p.y, d, col); dirs.push({ d, col }); }   // points AWAY = out-lane
        }
        fans.push({ p, dirs });
      }
    }
    return { tint, fans };
  }
  // a direction chevron (">" turned to d) built from u-sized blocks — belts must say WHICH WAY
  function lineChev(x2, cx, cy, d, col, u) {
    const E = [[-1, -2], [0, -1], [1, 0], [0, 1], [-1, 2]];
    x2.fillStyle = col;
    for (const o of E) {
      let ox = o[0], oy = o[1];
      if (d === 'W') ox = -o[0];
      else if (d === 'S') { ox = o[1]; oy = o[0]; }
      else if (d === 'N') { ox = o[1]; oy = -o[0]; }
      x2.fillRect(cx + ox * u, cy + oy * u, u, u);
    }
  }
  // the oblique-kit body in miniature: silhouette ring, face, lit top band — reads "machine"
  function lineBody(x2, X, Y, W, H, top, face, lit, dk) {
    x2.fillStyle = SCHEME.line; x2.fillRect(X - 1, Y - 1, W + 2, H + 2);
    x2.fillStyle = face; x2.fillRect(X, Y, W, H);
    x2.fillStyle = top; x2.fillRect(X, Y, W, Math.max(2, Math.round(H * 0.42)));
    x2.fillStyle = lit; x2.fillRect(X, Y, W, 1);
    x2.fillStyle = dk; x2.fillRect(X, Y + H - 1, W, 1);
  }
  function lineSchematic(bp) {
    // per-blueprint tile scale: fill the card's fixed viewport without ever scaling the canvas
    const S = Math.max(4, Math.min(12, Math.floor(160 / bp.w), Math.floor(56 / bp.h)));   // (a two-across tile of the line shelf)
    const PAD = 2, u = S >= 12 ? 2 : 1;
    const c = document.createElement('canvas');
    c.className = 'refit-linetile-cv';
    c.width = bp.w * S + PAD * 2; c.height = bp.h * S + PAD * 2;
    c.style.width = c.width + 'px'; c.style.height = c.height + 'px';   // 1:1 — pixel art is never scaled
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    x.translate(PAD, PAD);
    const lanes = traceLanes(bp);
    for (const b of bp.belts) {              // belts first (floor machinery): bed, rails, chevron
      const bx = b.x * S, by = b.y * S, horiz = b.d === 'E' || b.d === 'W';
      x.fillStyle = SCHEME.bed; x.fillRect(bx, by, S, S);
      const t = lanes.tint[b.x + ',' + b.y];
      if (t) { x.globalAlpha = 0.16; x.fillStyle = t; x.fillRect(bx, by, S, S); x.globalAlpha = 1; }
      x.fillStyle = SCHEME.rail;
      if (horiz) { x.fillRect(bx, by, S, 1); x.fillRect(bx, by + S - 1, S, 1); }
      else { x.fillRect(bx, by, 1, S); x.fillRect(bx + S - 1, by, 1, S); }
      lineChev(x, bx + (S >> 1), by + (S >> 1), b.d, t || SCHEME.chev, u);
    }
    for (const p of bp.props) {
      const X = p.x * S, Y = p.y * S, W = p.w * S, H = p.h * S;
      const m = Math.max(2, S >> 2), st = SCHEME.steel;
      if (p.t === 'intake') {                // INBOX — steel casing around the amber feed throat
        lineBody(x, X, Y, W, H, st.top, st.face, st.lit, st.dk);
        x.fillStyle = SCHEME.throat; x.fillRect(X + m, Y + m, W - m * 2, H - m * 2);
        x.fillStyle = SCHEME.amberDk; x.fillRect(X + m + 1, Y + m + 1, W - m * 2 - 2, H - m * 2 - 2);
        x.fillStyle = SCHEME.amber; x.fillRect(X + m + 1, Y + m + 1, W - m * 2 - 2, u);
      } else if (p.t === 'bay') {            // BAY — steel berth, green nameplate pip, amber berth ticks
        lineBody(x, X, Y, W, H, st.top, st.face, st.lit, st.dk);
        const nh = Math.max(2, Math.round(H * 0.30));
        x.fillStyle = SCHEME.plate; x.fillRect(X + m, Y + m, W - m * 2, nh);
        x.fillStyle = SCHEME.green; x.fillRect(X + (W >> 1) - u, Y + m + (nh >> 1) - (u >> 1), u * 2, u);
        x.fillStyle = SCHEME.greenHot; x.fillRect(X + (W >> 1), Y + m + (nh >> 1) - (u >> 1), u, u);
        x.fillStyle = SCHEME.amberDk;
        for (let i = X + m; i < X + W - m; i += 3) x.fillRect(i, Y + H - m - 1, 1, 1);
      } else if (p.t === 'outbox') {         // OUTBOX — the dark dispatch chute, green lamp
        lineBody(x, X, Y, W, H, SCHEME.chuteTop, SCHEME.chuteBody, '#2a352e', '#0a0f0c');
        x.fillStyle = SCHEME.chute; x.fillRect(X + m, Y + m, W - m * 2, H - m * 2);
        x.fillStyle = SCHEME.greenHot; x.fillRect(X + W - m - u * 2, Y + m + 1, u * 2, u);
        x.fillStyle = SCHEME.green; x.fillRect(X + m + 1, Y + H - m - u - 1, u * 2, u);
      } else {                               // junction (filter/splitter/merger/joiner/loop) — node + tinted arms
        const core = p.t === 'filter' ? SCHEME.violet : (p.t === 'splitter' ? SCHEME.green : p.t === 'loop' ? SCHEME.cyan : SCHEME.merge);
        const hot = p.t === 'filter' ? SCHEME.violetHot : (p.t === 'splitter' ? '#c8f4e6' : p.t === 'loop' ? '#bfefff' : p.t === 'joiner' ? '#ffc9a0' : '#ffd488');
        lineBody(x, X + 1, Y + 1, W - 2, H - 2, st.top, st.face, st.lit, st.dk);
        const cx = X + (W >> 1), cy = Y + (H >> 1);
        const fan = lanes.fans.find(f => f.p === p);
        if (fan) for (const a of fan.dirs) {   // an arm toward every out-lane, in that lane's colour
          x.fillStyle = a.col;
          for (let k = 1; k <= (S >> 1); k++) x.fillRect(cx + LINE_DIR[a.d][0] * k, cy + LINE_DIR[a.d][1] * k, 1, 1);
        }
        x.fillStyle = core; x.fillRect(cx - u, cy - u, u * 2, u * 2);
        x.fillStyle = hot; x.fillRect(cx - (u >> 1), cy - (u >> 1), Math.max(1, u), Math.max(1, u));
      }
    }
    return c;
  }
  /* ---------- THE CANDIDATE FIELD: "where can this line go?" ----------
     A blueprint is 17 tiles wide; a beginner arming one got a red ghost and no map, so finding a
     legal spot was a hunt. The field answers the question up front: every CURSOR tile whose stamp
     the model accepts, washed dim over the deck, and the ghost SNAPS to the nearest one so
     "click roughly there" lands.

     COST + DETERMINISM. One scan is (bounds + FIELD_MARGIN)² checkBlueprint calls — far too much
     for a frame. It runs lazily on first ask per blueprint and is cached until station.onChange
     drops it (clearLineFields). No RNG, no time input: the same floor always yields the same field.
     The scan is also bounded to the DECK's neighbourhood — every blueprint tile must sit on a room,
     so a legal anchor can never be more than half a footprint outside the station bounds. */
  const FIELD_MARGIN = 2;   // tiles of slack around the bounds — a centred footprint may hang its anchor just outside
  const SNAP_R = 3;         // "roughly there" = within this many tiles of a legal anchor
  function clearLineFields() {
    for (const k of Object.keys(lineFields)) delete lineFields[k];
    for (const k of Object.keys(lineFitsMemo)) delete lineFitsMemo[k];
    for (const k of Object.keys(lineLaidMemo)) delete lineLaidMemo[k];
    lineLaidQueue.length = 0;
  }
  /* LAID OUT TO FIT (conveyor-links phase E): when a line's DRAWN tile map fits nowhere, the layout engine may still lay the
     same line out on this floor — its tidy shape where a clear rectangle holds it, else anchored on its INBOX round what
     stands here (LineEdit.canPlaceBlueprint). That answer is dearer than the drawn-shape scan, so a card asks it in the
     background, one line at a time, and is re-said when it lands; it is cached until the floor changes, like lineFits. */
  const lineLaidMemo = Object.create(null), lineLaidQueue = [];
  let lineLaidT = 0;
  const lineLaidFits = bpId => (bpId in lineLaidMemo) ? lineLaidMemo[bpId] : undefined;
  function queueLineLaid(bpId) {
    if (typeof LineEdit === 'undefined' || !LineEdit.canPlaceBlueprint || (bpId in lineLaidMemo) || lineLaidQueue.indexOf(bpId) >= 0) return;
    lineLaidQueue.push(bpId);
    if (!lineLaidT) lineLaidT = setTimeout(stepLineLaid, 30);
  }
  function stepLineLaid() {
    lineLaidT = 0;
    const id = lineLaidQueue.shift();
    if (!id || !running || !station) return;
    let r = null;
    try { r = LineEdit.canPlaceBlueprint(station, id, lineNearTile()); } catch (e) { r = null; }
    lineLaidMemo[id] = r && r.ok ? { ok: true, via: r.via } : { ok: false, needs: (r && r.needs) || null };
    if (root) for (const b of root.querySelectorAll('.refit-linetile[data-line="' + id + '"]')) { const bp = blueprintOf(id); if (bp) setLineTileFit(b, bp); }
    if (lineLaidQueue.length) lineLaidT = setTimeout(stepLineLaid, 30);
  }
  // where a line would be laid when no click says: the middle of the view, else the middle of the station
  function lineNearTile() {
    const v = viewCenterTile();
    if (v) return v;
    const b = boundsMemoed();
    return { x: (b.minTx + b.maxTx) >> 1, y: (b.minTy + b.maxTy) >> 1 };
  }
  function lineField(bpId) {
    const bp = blueprintOf(bpId);
    if (!bp || !station) return null;
    if (lineFields[bpId]) return lineFields[bpId];
    const b = boundsMemoed();
    const hw = bp.w >> 1, hh = bp.h >> 1;
    const x0 = b.minTx + hw - FIELD_MARGIN, x1 = b.maxTx + hw + FIELD_MARGIN;
    const y0 = b.minTy + hh - FIELD_MARGIN, y1 = b.maxTy + hh + FIELD_MARGIN;
    const set = new Set(), list = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      if (!station.canPlaceBlueprint(bp.id, tx - hw, ty - hh).ok) continue;
      set.add(tx + ',' + ty); list.push({ tx, ty });
    }
    // pre-merge the wash into horizontal RUNS and its outline into EDGE segments, once. The frame
    // then paints tens of rects instead of thousands, and the boundary reads as one shape.
    const runs = [], edges = [];
    for (const c of list) {
      const last = runs[runs.length - 1];
      if (last && last.ty === c.ty && last.x2 === c.tx - 1) last.x2 = c.tx;
      else runs.push({ ty: c.ty, x1: c.tx, x2: c.tx });
      if (!set.has((c.tx - 1) + ',' + c.ty)) edges.push([c.tx, c.ty, c.tx, c.ty + 1]);
      if (!set.has((c.tx + 1) + ',' + c.ty)) edges.push([c.tx + 1, c.ty, c.tx + 1, c.ty + 1]);
      if (!set.has(c.tx + ',' + (c.ty - 1))) edges.push([c.tx, c.ty, c.tx + 1, c.ty]);
      if (!set.has(c.tx + ',' + (c.ty + 1))) edges.push([c.tx, c.ty + 1, c.tx + 1, c.ty + 1]);
    }
    return (lineFields[bpId] = { set, list, runs, edges });
  }
  /* does this blueprint fit ANYWHERE on the current deck? (shelf honesty — see renderPalette)
     The shelf asks this for EVERY blueprint on every palette render, and building a full field
     is thousands of checkBlueprint calls each — arming LINES on a large deck visibly froze. Existence
     needs only the FIRST legal anchor, so probe in the SAME scan order and stop at it. The two paths
     cannot disagree: both ask "does canPlaceBlueprint accept any anchor in the deck neighbourhood",
     over the identical rectangle. When the full field is already cached (the armed blueprint) it is
     used verbatim. Both are dropped together by clearLineFields on every station.onChange. */
  function lineFits(bpId) {
    if (lineFields[bpId]) return !!lineFields[bpId].list.length;
    if (bpId in lineFitsMemo) return lineFitsMemo[bpId];
    const bp = blueprintOf(bpId);
    if (!bp || !station) return false;   // no blueprint = nothing to cache (lineField returned null here)
    const b = boundsMemoed();
    const hw = bp.w >> 1, hh = bp.h >> 1;
    const x0 = b.minTx + hw - FIELD_MARGIN, x1 = b.maxTx + hw + FIELD_MARGIN;
    const y0 = b.minTy + hh - FIELD_MARGIN, y1 = b.maxTy + hh + FIELD_MARGIN;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++)
      if (station.canPlaceBlueprint(bp.id, tx - hw, ty - hh).ok) return (lineFitsMemo[bpId] = true);
    return (lineFitsMemo[bpId] = false);
  }
  /* SNAP: the ghost follows the cursor but lands on the nearest legal anchor within SNAP_R, so a
     click "roughly there" places the line. Beyond that radius the cursor tile is used raw and the
     ghost stays RED — a genuinely-nowhere-near aim must still be told no, not silently teleported
     across the deck. Ties break by (dy, dx) scan order, never by distance alone, so the snap is
     deterministic: the same pointer tile always resolves to the same anchor. */
  function lineSnap(tx, ty) {
    const f = lineField(lineType);
    if (!f || !f.list.length) return { tx, ty, snapped: false };
    if (f.set.has(tx + ',' + ty)) return { tx, ty, snapped: false };
    /* SEARCH THE RADIUS, NOT THE DECK. This walked the ENTIRE candidate list — thousands of tiles on
       a large floor — every frame the LINES ghost was live, only to throw the winner away unless it
       landed within SNAP_R. Any anchor outside the (2·SNAP_R+1)² box has |dx|>R or |dy|>R, hence
       d > R², hence it would have been rejected by that very check; so scanning only the box cannot
       change the answer. The box is walked in (dy, dx) order — the same order f.list is built in —
       and ties still break on the first strictly-smaller distance, so the snap stays deterministic
       and identical, tile for tile. */
    let bx = 0, by = 0, bestD = Infinity, found = false;
    for (let dy = -SNAP_R; dy <= SNAP_R; dy++) {
      for (let dx = -SNAP_R; dx <= SNAP_R; dx++) {
        const cx = tx + dx, cy = ty + dy;
        if (!f.set.has(cx + ',' + cy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bx = cx; by = cy; found = true; }
      }
    }
    if (!found || bestD > SNAP_R * SNAP_R) return { tx, ty, snapped: false };
    return { tx: bx, ty: by, snapped: true };
  }
  // the ghost's rect set + validity at a cursor tile — same {rects, v} contract every ghost uses
  function lineGhost(tx, ty) {
    const bp = blueprintOf(lineType);
    if (!bp) return null;
    const s = lineSnap(tx, ty);
    const o = lineOrigin(bp, s.tx, s.ty);
    const rects = bp.props.map(p => ({ x1: o.x + p.x, y1: o.y + p.y, x2: o.x + p.x + p.w - 1, y2: o.y + p.y + p.h - 1 }))
      .concat(bp.belts.map(b => ({ x1: o.x + b.x, y1: o.y + b.y, x2: o.x + b.x, y2: o.y + b.y })));
    const links = ghostLinks({ props: bp.props.map(p => ({ t: p.t, x: o.x + p.x, y: o.y + p.y, w: p.w, h: p.h })), belts: bp.belts.map(b => ({ x: o.x + b.x, y: o.y + b.y, d: b.d })) });
    const laid = lineLaidFits(bp.id);
    if (laid === undefined && !lineFits(bp.id)) queueLineLaid(bp.id);
    return { rects, v: station.canPlaceBlueprint(bp.id, o.x, o.y), kind: 'line', label: LINE_PLAIN[bp.id] || bp.label, snapped: s.snapped, links, laid: !!(laid && laid.ok) };
  }
  /* the test job the Workflow panel saved for the line this prop is on (localStorage, per station — the panel's own store),
     plus the line key; read by the live INBOX's COMMS card so ONE REAL JOB runs the Commander's own input (2026-09-27 X1) */
  function testJobForProp(propId) {
    try {
      const st = station || (opts && typeof opts.getStation === 'function' ? opts.getStation() : null);
      if (!st || typeof Pipeline === 'undefined' || !Pipeline.lineComponents) return null;
      const c = Pipeline.lineComponents(st.projectGeometry()).find(x => x.props.indexOf(propId) >= 0);
      if (!c) return null;
      let text = '';
      try { const o = JSON.parse(localStorage.getItem('starnet.refit.wftests.' + stationKeyOf(st)) || '{}'); const j = o && o.__jobs && o.__jobs[c.key]; if (typeof j === 'string') text = j.trim().slice(0, 2000); } catch (e) {}
      return { line: c.key, text };
    } catch (e) { return null; }
  }
  /* the line for the Commander's GOAL: their own dossier words (goals, then ambitions, then pain points — what onboarding
     asked), read by WorkflowLine.suggestLineFor for the shape of the work. The first belief that names a shape wins; none
     does → no card (never a guess). */
  function goalLine() {
    if (typeof DossierStore === 'undefined' || typeof WorkflowLine === 'undefined' || !WorkflowLine.suggestLineFor) return null;
    let texts = [];
    try { for (const k of ['goals', 'ambition', 'pain']) texts = texts.concat((DossierStore.beliefs(k) || []).map(b => String((b && b.text) || '').trim()).filter(Boolean)); }
    catch (e) { return null; }
    for (const t of texts) {
      const s = WorkflowLine.suggestLineFor(t), bp = s && blueprintOf(s.id);
      if (bp) return { bp, why: s.why, quote: t.length > 90 ? t.slice(0, 88).trimEnd() + '…' : t };
    }
    return null;
  }
  /* THE CONVEYORS TAB OPENS CALM (org P18, FINDINGS #32 — "the builder opens on a wall"): LINES shows FOR YOUR GOAL and ANY JOB;
     every other shelf is its name and count, folded, one click from open. A shelf opened or folded stays so for the session; until
     the Commander folds it, the shelf holding the ARMED line opens (its card and SET UP row show). Nothing is removed: every line
     is one click away. */
  const LINE_SHELF_OPEN = 'any';
  const lineShelfOpen = new Map();   // shelf id -> true (opened) / false (folded), by the Commander's own click
  const lineShelfShown = (id, bps) => id === LINE_SHELF_OPEN || (lineShelfOpen.has(id) ? lineShelfOpen.get(id) : (tool === 'line' && bps.some(bp => bp.id === lineType)));
  function lineShelfToggle(g, n, open) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'refit-linegroup refit-lineshelf-tog' + (open ? ' open' : '');
    b.dataset.shelf = g.id; b.setAttribute('aria-expanded', String(open));
    b.innerHTML = '<span class="refit-lineshelf-caret" aria-hidden="true">' + (open ? '▾' : '▸') + '</span> ' + esc(g.label) + ' <small>' + n + '</small>';
    b.dataset.tip = g.blurb;
    b.onclick = () => { lineShelfOpen.set(g.id, !open); sfx('click'); renderPalette(); };
    return b;
  }
  /* a shelf section's name, across its grid row — the Props tab's "FURNITURE / 128 ITEMS" voice: a name, never a blurb */
  function lineGroupHd(label, cls) {
    const hd = document.createElement('div'); hd.className = 'refit-linegroup' + (cls ? ' ' + cls : '');
    hd.textContent = label;
    return hd;
  }
  /* one ready-made line in its grid cell: the tile, and under it (only when the deck cannot hold the line) MAKE ROOM FOR IT; the
     armed line's SET UP row follows across the whole grid */
  function addLineCell(grid, bp, why, goal) {
    const cell = document.createElement('div'); cell.className = 'refit-linecell' + (goal ? ' refit-goalcell' : '');
    const b = makeLineTile(bp, why);
    cell.appendChild(b); grid.appendChild(cell);
    setLineTileFit(b, bp);   // DECK-FIT HONESTY — and kept current as the floor changes (see setLineTileFit)
    if (tool === 'line' && bp.id === lineType) grid.appendChild(linePrefsEl(bp));   // the armed card's settings, right under it
    return b;
  }
  /* one ready-made line's tile (the shelf AND the FOR YOUR GOAL tile) — the line's miniature, its plain name, one small line (its
     steps and size, or what its fit is: setLineTileFit). What the line is for, the catalog name it ships under and (for the goal
     tile) the Commander's own words are its hover tip and its accessible description. */
  function makeLineTile(bp, why) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'refit-linetile' + (tool === 'line' && bp.id === lineType ? ' active' : '');
    b.dataset.line = bp.id;
    b.setAttribute('aria-pressed', tool === 'line' && bp.id === lineType ? 'true' : 'false');
    const name = LINE_PLAIN[bp.id] || bp.label, purpose = LINE_PURPOSE[bp.id] || bp.desc || '';
    b.dataset.tip = name + (why ? '\n' + why : '') + (purpose ? '\n' + purpose : '');   // one name per line (2026-09-30): the station name is not a second name to learn
    b.setAttribute('aria-description', (why ? why + ' — ' : '') + purpose);
    const view = document.createElement('span'); view.className = 'refit-linetile-view';
    view.appendChild(lineSchematic(bp));
    b.appendChild(view);
    const nm = document.createElement('span'); nm.className = 'refit-matname'; nm.textContent = name;
    b.appendChild(nm);
    // steps + footprint, derived from the catalog (never hand-kept); setLineTileFit swaps in the fit when the drawn shape does not fit
    const docks = bp.props.filter(p => p.t === 'bay').length;
    const stat = document.createElement('span'); stat.className = 'refit-linetile-stat';
    stat.textContent = stat.dataset.rest = docks + (docks === 1 ? ' step' : ' steps');
    b.appendChild(stat);
    b.onclick = () => { lineType = bp.id; selectTool('line'); };
    return b;
  }
  /* DECK-FIT HONESTY. Offering a line the current floor has nowhere to put it is an offer the deck cannot keep — the
     user aims, gets red everywhere, and learns nothing. The card says so up front, from the SAME canPlaceBlueprint scan
     the ghost snaps to. It stays selectable (sandbox law: never gate) — arming it just shows an empty field and this reason.
     MAKE ROOM (2026-09-27 audit B1): 8 of the 19 lines never fit the starter room and nothing said how to get more floor.
     One click builds a room big enough, touching the station (auto-doors connect it), and arms the line over it. One UNDO
     removes the room. A sibling button — a button inside the card's button is not allowed.
     KEPT CURRENT (2026-09-28 retest): the cards were fit-checked only when the palette rendered, so an UNDO left eight of
     them claiming to fit a floor they no longer fit — the B1 trap again. setLineTileFit reconciles one card in place;
     scheduleLineFitSync re-reads every card on screen once the floor settles after an edit. */
  function setLineTileFit(b, bp) {
    const drawn = lineFits(bp.id), laid = drawn ? null : lineLaidFits(bp.id);
    if (!drawn && laid === undefined) queueLineLaid(bp.id);   // (asked in the background — the card is re-said when it lands)
    const fits = drawn || !!(laid && laid.ok);
    b.classList.toggle('nofit', !fits);
    b.classList.toggle('laidfit', !drawn && fits);
    // (2026-09-30) the fit is said on the tile's own small line — it used to be a sentence under the tile
    const stat = b.querySelector('.refit-linetile-stat'), say = t => { if (stat) stat.textContent = t; };
    const next = b.nextElementSibling;
    const make = next && next.classList.contains('refit-linetile-makeroom') ? next : null;
    if (drawn) { say(stat ? stat.dataset.rest || '' : ''); if (make) make.remove(); return; }
    if (fits) {   // the drawn shape fits nowhere, but the line does, laid out round what stands here (the ghost invites the click)
      say(stat ? stat.dataset.rest || '' : '');   // (it fits: the tile says its steps, like any other — never the layout engine's words)
      if (make) make.remove();
      return;
    }
    const need = laid && laid.needs ? laid.needs : { w: bp.w, h: bp.h };
    say(laid === undefined ? (stat ? stat.dataset.rest || '' : '') : 'needs more room');   // (the MAKE ROOM FOR IT key under the tile builds a room the size it needs)
    if (laid === undefined) { if (make) make.remove(); return; }
    if (make) return;
    const mk = document.createElement('button'); mk.type = 'button'; mk.className = 'bb refit-linetile-makeroom';
    mk.textContent = '＋ MAKE ROOM FOR IT'; mk.setAttribute('aria-label', 'Build a room big enough for ' + bp.label);
    mk.onclick = e => makeRoomFor(bp.id, e);
    b.after(mk);
  }
  let lineFitSyncT = 0;
  function scheduleLineFitSync() {
    if (lineFitSyncT) clearTimeout(lineFitSyncT);
    lineFitSyncT = setTimeout(() => {
      lineFitSyncT = 0;
      if (!running || !root) return;
      for (const b of root.querySelectorAll('.refit-linetile[data-line]')) { const bp = blueprintOf(b.dataset.line); if (bp) setLineTileFit(b, bp); }
    }, 350);
  }
  function makeRoomFor(bpId, ev) {
    const bp = blueprintOf(bpId);
    if (!bp || !station) return;
    const laid = lineLaidFits(bp.id), need = laid && laid.needs ? laid.needs : { w: bp.w, h: bp.h };
    const W = Math.min(bp.w, need.w) + 2, H = Math.min(bp.h, need.h) + 2;   // the smaller of the drawn and the laid-out line, a tile of walking room round it
    // the station's own room finder (worldmodel.roomSpots) — the same one the agent's station builder uses
    for (const rect of (station.roomSpots ? station.roomSpots(W, H, 'hab') : [])) {
      const res = station.addRoom({ kind: 'hab', rect });
      if (!res || !res.ok) continue;
      clearLineFields();
      lineType = bp.id; selectTool('line');
      sfx('chime');
      flashTip(ev, 'ROOM ADDED — click inside it to place ' + bp.label + ' · UNDO removes the room', true);
      try { fitCamera(); } catch (e) {}
      return;
    }
    sfx('bad');
    flashTip(ev, 'no clear space beside the station for a ' + W + '×' + H + ' room — use Rooms to draw one where you want it', false);
  }
  function stampLine(w, ev) {
    const bp = blueprintOf(lineType);
    if (!bp) return;
    // the SAME snap the ghost showed — the click commits exactly what was on screen, never the raw tile
    const s = lineSnap(w.tx, w.ty);
    const o = lineOrigin(bp, s.tx, s.ty);
    let res = station.stampBlueprint(bp.id, o.x, o.y, lineStampOpts(bp));   // ONE undoable action, with the card's cap + tries — see worldmodel.stampBlueprint
    /* LAID OUT TO FIT (phase E): where the drawn tile map will not go, the same line is laid out on the floor near the click —
       its tidy shape, or anchored on its INBOX round what stands here — with the same cap and tries, one UNDO */
    let laidOut = false;
    if (!(res && res.ok) && typeof LineEdit !== 'undefined' && LineEdit.placeBlueprint) {
      const lr = LineEdit.placeBlueprint(station, bp.id, { x: w.tx, y: w.ty }, { stamp: lineStampOpts(bp) });
      if (lr && lr.ok) { res = lr; laidOut = true; } else if (lr && lr.msg) res = lr;
    }
    if (res && res.ok) {
      lastStampIds = res.ids || null;   // the finish-the-line card adopts this line on the next recompile
      // LINE NAMING: a stamp leaves the intake's `label` UNSET (the save carries only what the Commander
      // typed) — but this session remembers which blueprint stamped it, so the intake card's name field
      // can offer the blueprint's name as its placeholder (session-scoped, like lastStampIds).
      try { for (const id of (res.ids || [])) { const sp = station.propById(id); if (sp && sp.t === 'intake') stampNameOf[id] = LINE_PLAIN[bp.id] || bp.label; } } catch (_) {}
      landProps((res.ids || []).map(id => station.propById(id)).filter(Boolean).sort((a, b) => a.x - b.x || a.y - b.y).map(p => p.id), 70);
      if (laidOut) pushFlash((res.ids || []).map(id => station.propById(id)).filter(Boolean).map(p => ({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 })), false);
      else pushFlash(bp.props.map(p => ({ x1: o.x + p.x, y1: o.y + p.y, x2: o.x + p.x + p.w - 1, y2: o.y + p.y + p.h - 1 })), false);
      sfx('chime');
      // PLACEMENT FLOW: a blueprint stamps ONCE, then the tool drops back to SELECT — the next
      // click on the fresh line inspects a dock instead of stamping a second copy on top of it.
      // (Deselect BEFORE the tip: selectTool hides any tip it finds.)
      deselectTool({ silent: true });
      /* WHAT NOW? (2026-09-27 audit B2): the stamp used to leave "Nothing is selected yet" and a tip, and the part that guides you
         — the Workflow panel, starting with "Who works here?" — only appeared if you thought to click a BAY. It opens now, on the
         line's first BAY, the moment the line lands (compiled first, so it names the line). */
      let firstBay = null;
      try { for (const id of (res.ids || [])) { const sp = station.propById(id); if (sp && sp.t === 'bay') { firstBay = sp.id; break; } } } catch (_) {}
      if (firstBay && typeof WorkflowPanel !== 'undefined') {
        try { rebake(); openFlowCard(firstBay); } catch (_) {}
        flashTip(ev, String(LINE_PLAIN[bp.id] || bp.label).toUpperCase() + (laidOut ? ' LAID OUT TO FIT HERE' : ' PLACED') + ' — pick who works each step in the panel', true);
      } else flashTip(ev, String(LINE_PLAIN[bp.id] || bp.label).toUpperCase() + ' PLACED — click each step to pick who works it', true);
      if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
      // belts just landed — the same first-touch coach a hand-laid run earns (points at ▸ PREVIEW)
      if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();
    } else {
      sfx('bad');
      flashTip(ev, (res && res.msg) || 'needs clear deck — every tile on a room, nothing in the way', false);
    }
  }

  /* NO STANDALONE CANVAS INVITATION (2026-08-07). A floating "START A WORK LINE HERE" prompt used
     to live here, painted on an empty deck. It was retired: STATION ORDERS (renderOrders) already
     sequences build mode — ① a second space → ② a deck → ③ a workstation → ④ STAMP A WORK LINE —
     and its step ④ arms this very tool. Two invitations to the same act is exactly the stacking the
     one-voice law forbids, and leading with the line reframed the whole mode as conveyor-first.
     The guidance path is: ORDERS invites → the tool arms → the candidate wash + snap below help
     you land it. Do not reinstate a second voice for the same step. */

  function selectTool(id, o) {
    if (id === 'move') id = 'select';   // the MOVE tool is retired (10-11): SELECT moves — a stale caller lands where moving lives now
    const wasSelect = tool === 'select';
    // arming any tool (or a bare deselect) puts down what was in hand — BEFORE the card repaints: an unanswered PICK WHAT GOES HERE
    // stayed docked with dead tiles after a tab switch, 0/9, BELT or Ctrl+V (wave 2, build-08)
    hand = null; touchArm = null; dropPick = null;
    selBelts=null;selectedPropId=null;groupIds=[];selectedRoomId=null;renderSelection();
    if (drag || dragPid != null) releaseDrag();
    tool = id; drag = null; connectFrom = null; connectTo = null; dupe = null; hideTip(); hidePropCard();
    if (id !== 'prop') deskOwner = null;
    if (id !== 'select' && !(o && o.keepGroup)) buildGroup = BUILD_GROUPS.find(g => g[2].includes(id))?.[0] || buildGroup;
    root.querySelectorAll('.refit-tool').forEach(b => {
      const active = b.dataset.tool === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    // arming a tool shows its options; a bare deselect (ESC, select→select) leaves a minimized library alone —
    // the docked Workflow panel may have stepped it aside, and a deselect is not a request to bring it back
    if ((id !== 'select' || !wasSelect) && !(o && o.keepKit)) toggleKit(false);   // (keepKit: the Workflow panel's JOIN A LINE arms BELT beside it)
    renderPalette(); repaintIcons(); setHint(); setCursor();
    if (buildGroup === 'props' && window.matchMedia('(max-width: 700px)').matches) fitCamera();
    renderFinCard();
    if (id === 'line') frameBlueprint();   // a footprint you cannot see whole cannot be aimed
    if (!(o && o.silent)) sfx('click');
  }
  /* FRAME THE GHOST. At the entering zoom a 17-tile line is wider than the glass, so half the
     footprint you are placing is off-screen. Arming a blueprint that does not fit the viewport
     pulls the camera back — through fitCamera(), the SAME framer the ⊹ FIT button runs (framing
     the station bounds necessarily frames any legal placement inside them; a second camera fitter
     would be a second set of insets/clamps to keep in sync). A blueprint that already fits is left
     alone: re-framing on every arm would yank the camera away from where the user was looking. */
  function frameBlueprint() {
    const bp = blueprintOf(lineType);
    if (!bp || !cv || !station) return;
    const t = T(), ins = viewInsets();
    const vw = Math.max(1, cv.width - ins.l), vh = Math.max(1, cv.height - ins.t - ins.b);
    // a tile of breathing room each side: a footprint flush against the glass still cannot be read
    if ((bp.w + 2) * t * zoom <= vw && (bp.h + 2) * t * zoom <= vh) return;
    fitCamera();
  }
  // every "drop whatever is armed" gesture (ESC, right-click, post-stamp) lands here
  function deselectTool(o) { if (tool !== 'select') selectTool('select', o); }

  /* ---------- THE STATUS STRIP (2026-08-07) ----------
     This was one run of 12px grey text in which the thing you most need — WHAT THE ARMED TOOL
     DOES — was indistinguishable from the camera keys you already know. It is now two ranks: the
     tool's imperative VERB in bright phosphor, and the standing camera/escape keys beneath it,
     dim. A transient message (passed as `msg`) takes the verb rank alone, because a transient
     message is always the more urgent of the two. */
  const CAMERA_KEYS = 'wheel zoom · space-drag pan · ESC deselect · ESC twice exit';
  function setHint(msg) {
    if (!hintEl) return;
    hintEl.classList.toggle('is-feedback', !!msg);
    const t = TOOLS.find(x => x.id === tool);
    // SURFACE means three different gestures depending on which surface is targeted — say which
    let verb = (t && t.verb) || (t && t.hint) || '';
    if (tool === 'select' && buildGroup === 'props') verb = 'Pick a prop, then click the floor to place it · click a placed one to edit it';
    if (tool === 'select' && buildGroup === 'workflow') verb = 'Drag a machine onto another to belt them · click a piece, then drag it onto open floor to move it · drag a belt to branch it · 1–8 pick a piece · Q picks up the one under the pointer · right-click removes a conveyor piece or belt · hold Alt to see every setting';
    // THE HAND: what is held, what a click does with it, and how to put it down (or what the armed dock key's next tap does)
    if (tool === 'select' && hand && hand.newLine) verb = 'Click where your line starts · Esc cancels';   // (the dock's hint bar shows ~45 characters; right-click cancels too)
    else if (tool === 'select' && hand) verb = 'Holding ' + propLabel(hand.t) + (hand.agentId ? ' (crewed by ' + agentLabel(hand.agentId) + ')' : '') + ' · click to place it' + (JUNCTION_TAG_TYPES[hand.t] ? ' · click a belt to put it on that line' : '') + ' · right-click or Esc puts it down';
    if (tool === 'dupe' && dupe && dupe.type === 'lines') verb = 'Holding ' + dupe.label + ' · click to place a copy (it stays in hand) · R turns it · right-click or Esc puts it down';   // THE HAND part 2
    if (tool === 'select' && touchArm === 'remove') verb = 'REMOVE · tap a conveyor piece or a belt to remove it · tap REMOVE again to stop';
    if (tool === 'select' && touchArm === 'pipette') verb = 'PICK UP · tap a piece to hold one like it · tap PICK UP again to stop';
    if (tool === 'select' && buildGroup === 'rooms') verb = 'Pick a room type, then drag on the grid · click a room to move, resize or furnish it';
    if (tool === 'select' && buildGroup === 'surfaces') verb = 'Pick a finish, then click a room to lay it · DECK, WALLS or SHELL';
    if (tool === 'paint') verb = paintTarget === 'hull' ? 'click a room to re-clad its outside'
      : paintTarget === 'walls' ? 'click a room to clad its walls'
      : 'click a room to lay this deck · drag to paint tiles';
    // the PROP hint carries the orientation the next stamp will use, and only advertises the keys
    // this prop actually honours — a prop with one authored facing never mentions R.
    if (tool === 'prop' && !msg) {
      const spec = catalog().find(c => c.id === propType);
      /* a 1×1 JUNCTION goes ON a belt (2026-09-27 audit P5): the compiler reads a splitter/joiner/filter/merger/loop by the
         belt under its own tile, and dropping one onto an existing lane is how every ready-made line is built — the old
         'clear deck tile' copy steered people to empty floor and three hand-wired belts. */
      const JUNC = { splitter: 1, joiner: 1, filter: 1, merger: 1, loop: 1 };
      if (WORKSTATION_TYPES[propType]) verb = (spec ? spec.label + ' · ' : '') + 'click a clear deck tile to place ' + (deskOwner ? agentLabel(deskOwner) + '’s desk' : 'it, then pick who sits there');
      else verb = (spec ? spec.label + ' · ' : '') + (JUNC[propType] ? 'drop it ON a belt to put it on that line, or on clear floor' : 'click a clear deck tile to place' + (rowable(propType) ? ' · drag for a row' : ''));
      const bits = [];
      if (canTurn(propType)) bits.push('R turn (facing ' + FACE_WORD[propFacing(propType)] + ')');
      if (canFlip(propType)) bits.push('M flip' + (propFlipOn(propType) ? ' ✓' : ''));
      if (bits.length) verb += ' · ' + bits.join(' · ');
    }
    hintEl.innerHTML = '<span class="refit-hint-verb">' + esc(msg || verb) + '</span>'
      + '<span class="refit-hint-keys">' + esc(CAMERA_KEYS) + '</span>';
    const help = root.querySelector('#refit-tool-help');
    if (help) {
      help.hidden = tool === 'select';
      const guidance = {
        room: 'Choose a room type. Drag in empty space to set its size.',
        hall: 'Choose a width, then drag between rooms to connect them.',
        dupe: 'Click the room or prop you want to copy, then click a clear space to place the copy.',
        reclaim: 'Click a room, prop or belt to remove it. Undo brings it back.',
        belt: 'Click a machine, then the next one: the belt lays itself. Or drag to lay belt by hand.',
        line: 'Choose a conveyor line, then click clear floor to place it. Assign agents after placing.'
      };
      help.querySelector('span').textContent = msg || ((tool === 'dupe' && dupe && dupe.type === 'lines') ? verb : guidance[tool]) || verb;
      help.querySelector('button').textContent = 'CANCEL';
      let turn = help.querySelector('#refit-turn');
      if (!turn) { turn = document.createElement('button'); turn.type = 'button'; turn.id = 'refit-turn'; turn.className = 'bb sm'; turn.textContent = 'TURN'; turn.onclick = () => turnClip(1, orientEv()); help.appendChild(turn); }
      turn.hidden = !(tool === 'dupe' && dupe && dupe.type === 'lines');
    }
  }
  function setCursor() {
    if (!cv) return;
    cv.style.cursor = cursorFor(false);
  }
  function cursorFor(shift) {
    const t = TOOLS.find(x => x.id === tool);
    return spaceHeld ? 'grab' : (tool === 'select' && hand) ? 'copy' : (tool === 'select' && touchArm) ? (touchArm === 'remove' ? 'not-allowed' : 'copy') : (selectAim(shift) || (t ? t.cursor : 'default'));
  }
  /* WHAT A DRAG HERE WILL DO, said by the pointer before the press (SELECT MOVES, 10-11): over a SELECTED piece — or with Shift
     held over any piece, or on the selected room's bare floor — the move cursor; over an UNSELECTED conveyor machine the
     belt-aiming crosshair (the one a belt drag wears). Anything else keeps SELECT's own cursor. Under an armed tool that lets
     the selection move (pressMovesSelection) the selected piece wears the move cursor too. */
  function selectAim(shift) {
    if (hand || touchArm || drag || !station) return null;
    const p = hoverPropId && station.propById(hoverPropId);
    if (tool !== 'select') return (p && (p.id === selectedPropId || groupIds.includes(p.id)) && pressMovesSelection()) ? 'move' : null;
    if (p) return (shift || p.id === selectedPropId || groupIds.includes(p.id)) ? 'move' : beltSource(p.id) ? 'crosshair' : null;
    // (Shift over a belt inside the selected room grabs the room too — a hallway its belt covers end to end has no bare floor)
    if (selectedRoomId && hoverTile && hoverRoomId === selectedRoomId && (shift || !station.beltAt(hoverTile.tx, hoverTile.ty))) return 'move';
    return null;
  }
  /* THE SELECTION MOVES UNDER AN ARMED TOOL TOO (repair 10-11). A piece gets selected while a tool is armed — the desk PROP just
     placed, a machine clicked with PROP / LINES / ROOM / HALLWAY / a copy in hand (CLICK-ON-MACHINE WINS) — and its card says
     "drag it to move". The retired MOVE key used to work from any tool; now a press on the selected piece (or a member of the
     selected group) drags it whatever is armed — EXCEPT where pressing that piece is the armed tool's own job: DELETE takes it,
     SURFACE paints its room, BELT connects from it, an empty COPY picks it up, a clip in hand lays out where it is clicked. */
  function pressMovesSelection() {
    if (tool === 'select') return !hand && !touchArm;
    if (tool === 'reclaim' || tool === 'paint' || tool === 'belt') return false;
    if (tool === 'dupe') return !!dupe && dupe.type !== 'lines';
    return true;   // prop · line · room · hall: their click on a placed piece inspects it, so a drag on the selected one moves it
  }
  function updateUndoRedo() {
    if (undoBtn) undoBtn.disabled = !station.canUndo();
    if (redoBtn) redoBtn.disabled = !station.canRedo();
  }

  /* ---------- first-use guide: the three beats, drawn ----------
     One painter per beat, on a 128×72 board of 4px cells (canvas is 3× that for crispness). Every
     mark is a rect — this is the same pixel vocabulary the station is built out of, and it renders
     the GESTURE, so the words underneath only have to name it. Colours come from the same three
     roles the live editor uses: phosphor for structure, green for a legal ghost, gold for a machine. */
  function guideStepArt(c, kind) {
    const x = c.getContext('2d'); if (!x) return;
    const S = c.width / 128;                       // one board unit in device px
    const R = (bx, by, bw, bh, fill) => { x.fillStyle = fill; x.fillRect(bx * S, by * S, bw * S, bh * S); };
    const PH = 'rgba(120,200,255,.55)', DIM = 'rgba(120,200,255,.16)', OK = 'rgba(120,255,170,.95)',
          OKF = 'rgba(80,255,140,.20)', GOLD = 'rgba(240,196,90,.95)', INK = 'rgba(6,9,12,.9)', LIT = 'rgba(180,240,255,.9)';
    x.clearRect(0, 0, c.width, c.height);
    R(0, 0, 128, 72, 'rgba(8,12,16,.75)');
    // the deck grid every beat happens on — 8-unit cells, the editor's own minor lattice
    for (let gx = 0; gx <= 128; gx += 8) R(gx, 0, 1, 72, DIM);
    for (let gy = 0; gy <= 72; gy += 8) R(0, gy, 128, 1, DIM);

    if (kind === 'room') {
      // a room being dragged out: a green footprint with corner brackets and the cursor at its far corner
      R(24, 16, 56, 40, OKF);
      R(24, 16, 56, 1, OK); R(24, 55, 56, 1, OK); R(24, 16, 1, 40, OK); R(79, 16, 1, 40, OK);
      // corner brackets — (cx,cy) is the corner itself, sx/sy point INTO the rect
      const br = (cx, cy, sx, sy) => {
        R(sx > 0 ? cx : cx - 9, cy - 1, 10, 3, OK);
        R(cx - 1, sy > 0 ? cy : cy - 9, 3, 10, OK);
      };
      br(24, 16, 1, 1); br(80, 16, -1, 1); br(24, 56, 1, -1); br(80, 56, -1, -1);
      // the size badge the real drag prints on the ghost
      R(40, 4, 26, 10, INK); R(40, 4, 26, 1, OK); R(40, 13, 26, 1, OK); R(40, 4, 1, 10, OK); R(65, 4, 1, 10, OK);
      for (let i = 0; i < 5; i++) R(44 + i * 4, 8, 2, 2, OK);
      // cursor arrow at the drag's live corner
      for (let i = 0; i < 9; i++) R(80, 56 + i, Math.max(1, 8 - i), 1, LIT);
      R(84, 62, 2, 5, LIT);
    } else if (kind === 'bay') {
      // a dock with an agent walking into it: the machine, the crew body, the bind arrow
      R(64, 24, 32, 26, 'rgba(52,58,64,.95)'); R(64, 24, 32, 2, GOLD); R(64, 48, 32, 2, GOLD);
      R(68, 30, 24, 10, 'rgba(20,26,30,.95)');
      for (let i = 0; i < 5; i++) R(70 + i * 5, 33, 3, 4, GOLD);
      // the crew body (head + torso), reading left-to-right into the dock
      R(24, 26, 8, 8, 'rgba(226,206,170,.95)'); R(22, 36, 12, 14, 'rgba(120,200,255,.8)');
      R(22, 50, 4, 6, 'rgba(60,70,80,.95)'); R(30, 50, 4, 6, 'rgba(60,70,80,.95)');
      // bind arrow
      R(38, 36, 20, 2, PH); R(56, 33, 2, 8, PH); R(54, 35, 2, 4, PH);
    } else {
      /* the belt a DRAG lays — THROUGH the bay from beat 2, never machine-to-machine direct.
         The old art wired two anonymous machines straight together: exactly the bay-less line that
         compiles fine and moves NOTHING (crates only ride a lane that reaches a crewed dock). The
         first picture a Commander ever sees of the belt tool must not teach the one dead layout, so
         the middle machine wears beat 2's gold display — the bay they just crewed, now on the line. */
      R(2, 26, 22, 22, 'rgba(52,58,64,.95)'); R(2, 26, 22, 2, PH);                 // INBOX
      R(53, 26, 22, 22, 'rgba(52,58,64,.95)'); R(53, 26, 22, 2, GOLD); R(53, 46, 22, 2, GOLD);   // the BAY
      R(56, 30, 16, 8, 'rgba(20,26,30,.95)');
      for (let i = 0; i < 3; i++) R(58 + i * 5, 32, 3, 4, GOLD);
      R(104, 26, 22, 22, 'rgba(52,58,64,.95)'); R(104, 26, 22, 2, PH);             // OUTBOX
      // two belt legs, one style: INBOX -> BAY, BAY -> OUTBOX
      R(24, 32, 29, 10, 'rgba(24,30,34,.95)'); R(24, 32, 29, 1, PH); R(24, 41, 29, 1, PH);
      R(75, 32, 29, 10, 'rgba(24,30,34,.95)'); R(75, 32, 29, 1, PH); R(75, 41, 29, 1, PH);
      for (const bx of [27, 37, 47, 79, 89, 99]) { R(bx, 34, 2, 2, PH); R(bx + 2, 36, 2, 2, PH); R(bx, 38, 2, 2, PH); }
      R(31, 22, 12, 10, GOLD); R(33, 24, 8, 6, 'rgba(120,90,30,.9)');   // a crate riding leg one
      /* the gesture (THE HAND, repair 2026-10-11 — the caption says DRAG, so the picture does too): a press on the INBOX, a stroke
         to the BAY ending in the pointer — and the next drag, BAY to OUTBOX, waiting dimmer. Never the old click-click crosshairs. */
      R(10, 16, 6, 6, LIT); R(11, 17, 4, 4, INK); R(12, 18, 2, 2, LIT);                        // the press, on the INBOX
      for (let gx = 19; gx <= 55; gx += 4) R(gx, 18, 2, 2, LIT);                            // the stroke, dragged to the BAY
      for (let i = 0; i < 9; i++) R(60, 13 + i, Math.max(1, 8 - i), 1, LIT); R(64, 19, 2, 5, LIT);   // the pointer, let go over the BAY
      for (let gx = 72; gx <= 104; gx += 4) R(gx, 18, 2, 2, PH);                            // the next drag: BAY to OUTBOX
      R(110, 15, 6, 6, PH);
    }
  }

  /* ---------- THE CARD STACK (2026-08-07 conveyor audit) ----------
     Every modal card in BUILD MODE — the first-run guide, the step editor, the workstation picker, the flow /
     belt / junction / connector / room / door cards — mounts as `.refit-guide` + its own marker class, and
     each one owns a `closeP` that does the work closing it OWES: the step card saves the job brief, the
     flow card saves the line name, the room card saves the rename. Nothing outside those closures could
     reach them, so two callers took a shortcut and paid for it:
       • ESC matched `.refit-guide` — the class they ALL share — then markSeen()'d and removeChild()'d
         directly. Pressing ESC over a step card threw away an unsaved job brief AND permanently marked
         the build-mode guide seen, for a card that was not the guide. The law was even written down two
         hundred lines below ("gate on `.refit-firstrun`, NEVER `.refit-guide`") and broken here.
       • Every opener bailed out (`if (already mounted) return`) instead of replacing, so FINISH ① CREW
         and the live world's NO AGENT nag did NOTHING while any other dock's card was open.
     So: a card REGISTERS its own close path on its element, and both callers route through it. Closing is
     always the card's own closing; opening always replaces whatever is up. */
  function cardRegister(el, closeFn) {
    el._refitClose = closeFn;
    if (el.classList.contains('refit-workflow-editor') || el.classList.contains('refit-preset-example')) {
      el.addEventListener('keydown', e => {
        if (e.key !== 'Tab') return;
        const fields = [...el.querySelectorAll('button,input,textarea,select,summary,[tabindex]')]
          .filter(n => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
        const first = fields[0], last = fields[fields.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      });
      requestAnimationFrame(() => { if (el.isConnected) el.querySelector('[data-workflow-close]')?.focus({ preventScroll: true }); });
    }
    return el;
  }
  // topmost = last mounted (DOM order); these cards are appended, never re-ordered
  function cardTop() {
    if (!root) return null;
    const all = root.querySelectorAll('.refit-guide');
    return all.length ? all[all.length - 1] : null;
  }
  // close ONE card through its own path (which is what saves what that card saves)
  function cardClose(el) {
    if (!el) return false;
    const fn = el._refitClose;
    el._refitClose = null;             // a close path that re-enters must not run twice
    if (typeof fn === 'function') { try { fn(); } catch (e) { console.warn('[refit] card close path threw', e); } }
    if (el.parentNode) el.parentNode.removeChild(el);   // backstop: every closeP already removes itself
    return true;
  }
  // an opener calls this FIRST: whatever is up closes properly, then the new card takes the surface.
  function cardCloseAll() { for (let i = 0; i < 16; i++) { const el = cardTop(); if (!el) break; cardClose(el); } }

  /* STATION PRESETS (reimagined 2026-09-28). Two groups: WORK presets — a whole station for one kind of work, its line
     wired, every step's instructions written, a sample job ready — and LOOK presets (rooms and furniture only). Picking
     a card previews what it builds; applying replaces the layout in one undoable step (the old one is backed up), and a
     WORK preset opens its setup guide straight after. Staffing is that guide's next click — a preset never hires. */
  const PRESET_GROUPS = [
    ['work', 'BUILT FOR YOUR WORK', 'A whole station for one kind of work. Its line is wired, every step has instructions, and a sample job is ready to try.'],
    ['look', 'JUST THE LOOK', 'Rooms and furniture only. Add a line from the Lines shelf whenever you want one.'],
  ];
  function presetPreviewHTML(item, doc) {
    const guide = StationTemplates.guides && StationTemplates.guides[item.id];
    const rooms = item.rooms + (item.rooms === 1 ? ' room' : ' rooms');
    if (!guide) return '<span><b>' + esc(item.name) + '</b> · ' + rooms + ' · ' + doc.props.length + ' props</span><span class="station-build-need">Rooms and furniture only; add a line from the Lines shelf whenever you want one.</span>';
    const steps = Object.values(guide.roles).map(r => r.name);
    return '<span><b>' + esc(item.name) + '</b> · ' + rooms + '</span>'
      + '<span class="station-build-flow">' + guide.flow.map(esc).join(' <i>→</i> ') + '</span>'
      + '<span>' + esc(guide.purpose) + '</span>'
      + '<span class="station-build-need">Next you choose who works ' + (steps.length === 1 ? 'its one step' : 'its ' + steps.length + ' steps') + ' (' + esc(steps.join(', ')) + '). One agent can work every step.'
      + (item.purpose === 'code' ? ' Point its Inbox at your project folder so the Builder works on your code.' : '') + '</span>';
  }
  function showStationBuilds() {
    if (!root || !station || typeof StationTemplates === 'undefined') return;
    cardCloseAll();
    const g = document.createElement('div');
    g.className = 'refit-guide refit-station-builds refit-workflow-editor';
    g.setAttribute('role','dialog');g.setAttribute('aria-modal','true');g.setAttribute('aria-label','Station presets');
    g.innerHTML = '<div class="refit-guide-box station-build-box"><div class="station-build-heading"><div><span class="station-build-eyebrow">BUILD MODE / STATION PRESETS</span><h2>A place for your work</h2></div><button class="bb sm" data-workflow-close>BACK TO BUILD</button></div>' +
      '<p class="station-build-intro">Pick a station for the kind of work you do, then make it yours. Every station includes your workstation and all five essentials.</p>' +
      '<div class="station-build-scroll">' + PRESET_GROUPS.map(([id, label, blurb]) => '<section class="station-build-section" data-build-section="' + id + '"><div class="station-build-section-head"><h3>' + label + '</h3><p>' + esc(blurb) + '</p></div><div class="station-build-grid" aria-label="' + esc(label.toLowerCase()) + '"></div></section>').join('') + '</div>' +
      '<div class="station-build-footer"><div class="station-build-status" role="status">Select a preset to see what it builds.</div>' +
      '<div class="station-build-actions"><button class="bb" data-restore-build>RESTORE PREVIOUS</button><button class="bb refit-primary" data-use-build disabled>CHOOSE A PRESET</button></div><small class="station-build-note">Applying replaces rooms, props and conveyors. Your current layout is backed up; agents and conversations stay.</small></div></div>';
    g.style.setProperty('--station-build-scale', typeof U.uiZoom === 'function' ? U.uiZoom() : 1);
    const closeP = () => { g.remove(); root?.querySelector('#refit-stations')?.focus(); };
    cardRegister(g, closeP); root.appendChild(g);
    g.querySelector('[data-workflow-close]').onclick = closeP;
    const status = g.querySelector('.station-build-status'), apply = g.querySelector('[data-use-build]');
    const current = currentPresetExample();
    if (current) {
      const setup = document.createElement('button'); setup.className='bb'; setup.textContent='SET UP ' + String(current.title).toUpperCase();
      setup.onclick=openPresetExample; g.querySelector('.station-build-actions').prepend(setup);
    }
    const backupKey = 'starnet.layoutBackup.' + station.doc().meta.createdAt;
    let selected = null, armed = false;
    const backupButton = g.querySelector('[data-restore-build]');
    try { backupButton.disabled = !localStorage.getItem(backupKey); } catch (_) { backupButton.disabled = true; }
    for (const item of StationTemplates.catalog) {
      const grid = g.querySelector('[data-build-section="' + (item.group === 'work' ? 'work' : 'look') + '"] .station-build-grid');
      const button = document.createElement('button'); button.className = 'bb station-build-card';
      button.type = 'button'; button.dataset.stationBuild = item.id; button.setAttribute('aria-pressed','false');
      const doc = StationTemplates.build(item.id, WorldModel, PropSprites);
      const bays = doc.props.filter(p=>p.t==='bay').length;
      button.innerHTML = '<div class="station-build-art"><canvas width="460" height="280" aria-hidden="true"></canvas><span class="station-build-check" aria-hidden="true">✓</span></div><div class="station-build-copy"><div class="station-build-meta"><span>' + item.rooms + (item.rooms === 1 ? ' ROOM' : ' ROOMS') + '</span>' + (bays ? '<span>'+bays+'-STEP LINE</span>' : '') + '</div><b>' + esc(item.name) + '</b><small>' + esc(item.description) + '</small></div>';
      const bounds = WorldModel.create(doc).bounds(), ctx = button.querySelector('canvas').getContext('2d');
      ctx.scale(2,2);
      const theme = getComputedStyle(root), accent = theme.getPropertyValue('--ph').trim() || '#b6a375';
      const scale = Math.min(210/(bounds.maxTx-bounds.minTx+1),120/(bounds.maxTy-bounds.minTy+1));
      const ox = (230-(bounds.maxTx-bounds.minTx+1)*scale)/2, oy = (140-(bounds.maxTy-bounds.minTy+1)*scale)/2;
      for (const room of Object.values(doc.rooms)) for (const r of room.rects) {
        ctx.fillStyle = room.kind==='corridor'?'#343636':room.floorMat==='plank'?'#494139':'#343e43'; ctx.strokeStyle=accent;
        const x=ox+(r.x1-bounds.minTx)*scale,y=oy+(r.y1-bounds.minTy)*scale,w=(r.x2-r.x1+1)*scale,h=(r.y2-r.y1+1)*scale;
        ctx.fillRect(x,y,w,h);ctx.strokeRect(x+.5,y+.5,w-1,h-1);
      }
      for(const key of Object.keys(doc.belts)) {const [x,y]=key.split(',').map(Number);ctx.fillStyle='#b6a375';ctx.fillRect(ox+(x-bounds.minTx)*scale,oy+(y-bounds.minTy)*scale,scale,scale);}
      for(const p of doc.props) {ctx.fillStyle=WorldModel.capForProp(p.t)?'#d2b276':'#6d957e';ctx.fillRect(ox+(p.x-bounds.minTx)*scale,oy+(p.y-bounds.minTy)*scale,Math.max(2,p.w*scale),Math.max(2,p.h*scale));}
      button.onclick = () => {
        selected=item;armed=false;apply.disabled=false;apply.textContent='USE '+item.name;
        for(const b of g.querySelectorAll('[data-station-build]'))b.setAttribute('aria-pressed',b===button?'true':'false');
        status.innerHTML=presetPreviewHTML(item, doc);
      };
      grid.appendChild(button);
    }
    apply.onclick = () => {
      if(!selected)return;
      if(!armed){armed=true;apply.textContent='CONFIRM — USE '+selected.name;status.textContent='Replace the current rooms, props, and conveyors with '+selected.name+'? Agents and conversations remain. Click again to apply.';return;}
      try {
        const doc=StationTemplates.build(selected.id,WorldModel,PropSprites,station.doc()._nid+100);
        localStorage.setItem(backupKey,JSON.stringify(station.serialize()));
        const result=station.replaceLayout(doc);if(!result.ok)throw Error(result.msg||result.error);
        fitCamera();closeP();sfx('click');
        if (currentPresetExample()) openPresetExample();   // a WORK preset: choosing who works it is the next click
      }catch(e){armed=false;status.textContent='Layout unchanged: '+e.message;apply.textContent='USE '+selected.name;}
    };
    backupButton.onclick = () => {
      try {
        const originalBackup=localStorage.getItem(backupKey),saved=JSON.parse(originalBackup);
        const current=JSON.stringify(station.serialize());
        localStorage.setItem(backupKey,current);
        const result=station.replaceLayout(saved);
        if(!result.ok){localStorage.setItem(backupKey,originalBackup);throw Error(result.msg||result.error);}
        fitCamera();closeP();
      }catch(e){status.textContent='Could not restore the previous layout: '+e.message;}
    };
  }

  function currentPresetExample() {
    return typeof StationTemplates !== 'undefined' && StationTemplates.example
      ? StationTemplates.example(station.serialize(),WorldModel,Pipeline,typeof WorkflowLine !== 'undefined' ? WorkflowLine : null) : null;
  }
  /* THE SETUP GUIDE (every WORK preset, 2026-09-28; was Creative Studio only, and refused one agent on both steps). Steps
     come in the line's run order. Each offers the crew, a one-click RECRUIT of that step's specialist (summonForRole —
     the Workflow panel's own seam) and, when the step's agent has no computer of its own there, the panel's ADD A
     WORKSTATION fix (requisitionPcFor). One agent may work every step (multi-bay). Readiness is StationTemplates.example
     → WorkflowLine.readiness: the Workflow panel pill's own blocking list. RUN SAMPLE posts the plan and runs the
     preset's sample job through the real harness (finRunSample). */
  function openPresetExample() {
    const first = currentPresetExample();
    if (!root || !first) return;
    cardCloseAll();
    const g = document.createElement('div');
    g.className = 'refit-guide refit-preset-example';
    g.setAttribute('role','dialog'); g.setAttribute('aria-modal','true'); g.setAttribute('aria-label','Set up '+first.title);
    g.innerHTML = '<div class="refit-guide-card"><header class="refit-prop-actions-head"><div><span class="ui-overline">SET UP YOUR STATION</span><h3>'+esc(first.title)+'</h3></div><button class="bb" data-workflow-close>CLOSE</button></header><div data-example-body></div></div>';
    let unsubscribe;
    const closeP = () => { unsubscribe?.(); g.remove(); root?.querySelector('[data-build-group="workflow"]')?.focus(); };
    cardRegister(g,closeP); root.appendChild(g); g.querySelector('[data-workflow-close]').onclick = closeP;
    const say = t => { const el = g.querySelector('.example-status'); if (el) el.textContent = t; };
    const needsPc = r => !!r.agentId && bayObjectsMemoed(r.agentId, r.propId).indexOf('computer') < 0;
    const refresh = () => {
      if (!g.isConnected) return;
      const e = currentPresetExample(); if (!e) return closeP();
      const agents = (opts.agents && opts.agents()) || [];
      const pending = !!finSampleRes?.pending;
      const rosterOK = e.roles.length > 0 && e.roles.every(r=>agents.some(a=>a.id===r.agentId));
      const ready = e.ready && rosterOK;
      const signature = JSON.stringify(station.serialize());
      const sr = finSampleRes?.key===e.key && finSampleRes?.exampleSignature===signature ? finSampleRes : null;
      const status = e.issue ? e.issue : !rosterOK ? 'Choose an agent from your crew for each step.' : sr?.pending ? 'Job in progress…' : sr?.view?.ok ? 'Job delivered · the harness confirmed delivery to the outbox.' : 'Ready · every step has an agent.';   // (org D7) one word set with its ▶ SEND A REAL JOB key: a real job, never 'the sample'; (org D4 polish) the status says the state, the key above names the act
      const canSummon = typeof App !== 'undefined' && !!App.summonAgent;
      const firstAid = e.roles[0] && e.roles[0].agentId;
      const offerAll = e.roles.length > 1 && !!firstAid && e.roles.some(r=>r.agentId!==firstAid);
      const software = station.doc().meta.templateId === 'software';
      const body = g.querySelector('[data-example-body]');
      body.innerHTML = '<p class="example-purpose">'+esc(e.purpose)+'</p><div class="example-flow" aria-label="How the line runs">'+e.flow.map(x=>'<span>'+esc(x)+'</span>').join('<b>→</b>')+'</div>'+
        '<h4>Choose who works each step</h4><div class="example-roles">'+e.roles.map((r,i)=>'<div class="example-role"><b>'+(i+1)+'. '+esc(r.name)+'</b><span>'+esc(r.description)+'</span>'+
          '<div class="example-role-pick"><select class="refit-input" aria-label="'+esc(r.name)+' agent" data-example-agent="'+esc(r.propId)+'"'+(pending?' disabled':'')+'><option value="">Choose an agent</option>'+agents.map(a=>'<option value="'+esc(a.id)+'"'+(a.id===r.agentId?' selected':'')+'>'+esc(a.name||a.id)+'</option>').join('')+'</select>'+
          (canSummon && r.role ? '<button type="button" class="bb sm" data-example-recruit="'+esc(r.propId)+'"'+(pending?' disabled':'')+'>+ RECRUIT</button>' : '')+'</div>'+
          (needsPc(r) ? '<div class="example-role-fix"><span>This agent has no desk of its own here.</span><button type="button" class="bb sm" data-example-pc="'+esc(r.propId)+'"'+(pending?' disabled':'')+'>⊕ GIVE '+esc(String(agentLabelFor(r.agentId)).toUpperCase())+' A DESK</button></div>' : '')+'</div>').join('')+'</div>'+
        (offerAll ? '<button type="button" class="bb sm example-all" data-example-all'+(pending?' disabled':'')+'>GIVE '+esc(String(agentLabelFor(firstAid)).toUpperCase())+' EVERY STEP</button>' : '')+
        '<p class="example-note">'+(agents.length ? 'One agent can work every step. ' : 'You have no agents yet. ')+(canSummon ? 'RECRUIT adds that step\'s specialist to your crew; it costs nothing until it works.' : '')+'</p>'+
        '<p class="example-note">Assignments save when selected. Each step\'s instructions live on its Bay; click the Bay to edit them.</p>'+
        '<section class="example-sample"><h4>Send a real job</h4><p>'+esc(e.sample.replace(/^SAMPLE JOB: /,''))+'</p><p class="example-note">This is one real job: the agents you chose run it on their own models, and normal model costs apply.</p><button class="bb refit-primary" data-example-run'+(!ready||pending?' disabled':'')+'>'+(pending?'JOB IN PROGRESS…':sr?.view?.ok?'↻ SEND IT AGAIN':'▶ SEND A REAL JOB')+'</button></section>'+
        '<p class="example-status" role="status">'+esc(status)+'</p>'+
        (sr?.view ? '<div class="example-result">'+finSampleHTML(sr.view)+finOnwardHTML(sr)+(sr.output?'<details><summary>Read the finished result</summary><pre>'+esc(sr.output)+'</pre></details>':'')+'</div>' : '')+
        /* NEXT: USE IT FOR REAL — one click to the Inbox's own settings in the Workflow panel (what starts it; the working
           folder a software line builds in), instead of a sentence about where to click */
        '<section class="example-next"><h4>Use it for real</h4><p>'+(software ? 'Choose the project folder the Builder works in, and when the line runs: on a schedule or from a chat app.' : 'Choose when the line runs: on a schedule or from a chat app.')+' Finished work lands in its OUTBOX and is also filed in DELIVERABLES.</p>'+
        (e.inboxId ? '<button type="button" class="bb" data-example-inbox'+(pending?' disabled':'')+'>'+(software ? 'OPEN THE INBOX: FOLDER + START' : 'OPEN THE INBOX: HOW IT STARTS')+'</button>' : '')+'</section>';
      body.querySelectorAll('[data-example-agent]').forEach(select => { select.onchange = () => {
        const propId = select.dataset.exampleAgent;
        const result = station.assignPropAgent(propId,select.value);
        if (!result.ok) say(result.msg || 'That assignment could not be saved.');
        else { refresh(); g.querySelector('[data-example-agent="'+propId+'"]')?.focus(); }
      }; });
      body.querySelectorAll('[data-example-recruit]').forEach(b => { b.onclick = () => {
        const r = e.roles.find(x=>x.propId===b.dataset.exampleRecruit); if (!r) return;
        b.disabled = true;
        const ri = WorldModel.bayRoleInfo ? WorldModel.bayRoleInfo(r.role) : null;
        const a = summonForRole(r.role, ri), res = a && station.assignPropAgent(r.propId, a.id);
        if (res && res.ok) { sfx('chime'); refresh(); }
        else { b.disabled = false; sfx('bad'); say(a ? 'Recruited, but the step refused the assignment. Pick the new agent from the list.' : 'Recruiting failed. Pick an agent from your crew instead.'); }
      }; });
      body.querySelectorAll('[data-example-pc]').forEach(b => { b.onclick = () => {
        b.disabled = true;
        const res = requisitionPcFor(b.dataset.examplePc);
        if (res.ok) { bumpGeo(); sfx('chime'); refresh(); }
        else { b.disabled = false; sfx('bad'); say(res.reason === 'no-room-for-a-desk' ? 'There is no clear floor for a desk in this room. Make some space, then try again.' : 'A workstation could not be placed here.'); }
      }; });
      const inboxBtn = body.querySelector('[data-example-inbox]');
      if (inboxBtn) inboxBtn.onclick = () => { closeP(); try { rebake(); openFlowCard(e.inboxId); } catch (_) {} };
      const all = body.querySelector('[data-example-all]');
      if (all) all.onclick = () => { for (const r of e.roles) station.assignPropAgent(r.propId, firstAid); sfx('click'); refresh(); };
      body.querySelector('[data-example-run]').onclick = () => {
        const now = currentPresetExample();
        if (!now?.ready || finSampleRes?.pending) return;
        finRunSample({key:now.key},{text:now.sample,exampleSignature:JSON.stringify(station.serialize()),onUpdate:refresh});
      };
    };
    unsubscribe = station.onChange(refresh); refresh();
  }

  /* ---------- first-use guide ---------- */
  function hasSeen() { try { return !!localStorage.getItem(SEEN_KEY); } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {} }
  /* TUTORIAL WINS (same coordination dockglow.js uses). The kit-out tour ALWAYS causes the first BUILD MODE open,
     so this first-run card used to land on top of it every single time: a full-viewport modal that BLOCKS the
     ⚇ PROP button the tour's ring is pulsing on, while teaching a different lesson (rooms/BAYs/belts) than the
     coach bubble floating above it (gear placement). Deferring costs nothing — markSeen() only fires on
     dismiss, so hasSeen() stays false and the card shows on the next BUILD MODE open, once the tour is out of the
     way and the Commander is actually building. #refit-help re-opens it on demand either way. */
  function tutorialCoaching() { try { return !!(typeof Tutorial !== 'undefined' && Tutorial.isCoaching && Tutorial.isCoaching()); } catch (e) { return false; } }
  /* THE NAMES THE GUIDE USES ARE READ FROM THE UI ITSELF (2026-09-23 playtest: the guide named a PROPS →
     WORKSTATIONS & WORKFLOWS tab and a "LAYOUTS (9)" button that no longer existed). Tab, tool and button
     labels come from BUILD_GROUPS / TOOLS / PREVIEW_LABEL; counts from the live catalogs — so renaming a
     tab or adding a line updates the guide and the Field Manual (Build.refitNames) with it. */
  function guideNames() {
    const grp = (BUILD_GROUPS.find(g => g[0] === 'workflow') || [])[1] || 'Conveyors';
    const lbl = id => ((TOOLS.find(x => x.id === id) || {}).label) || id.toUpperCase();
    const keyOf = id => ((TOOLS.find(x => x.id === id) || {}).key) || '';
    return { tab: String(grp).toUpperCase(), lines: lbl('line'), belt: lbl('belt'), lineKey: keyOf('line'), beltKey: keyOf('belt'),
      preview: PREVIEW_LABEL, lineCount: blueprints().length, machinesShelf: MACHINES_LABEL,
      machines: workflowMachines().map(c => ({ id: c.id, label: c.label, purpose: PALETTE_PURPOSE[c.id] || '', junction: (c.w || 1) === 1 && (c.h || 1) === 1 })) };
  }
  function showGuide() {
    if (!root || root.querySelector('.refit-guide')) return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-firstrun';   // refit-firstrun marks THIS card (not the pickers/editors that share .refit-guide) so tutorial.js can avoid painting a coachmark over it
    // Three beats, not a wall — place a room, place+assign a BAY, wire it with a BELT. The full reference (every prop
    // & mechanic) lives in the FIELD MANUAL, so we point there instead of front-loading it all here.
    /* SHOWN, not told (2026-08-07). This card was four prose bullets — the first thing a Commander
       ever sees of build mode, and it read like documentation. The three beats are the same three
       beats; each now leads with a PICTURE of the gesture (drawn in the station's own pixel language
       by guideStepArt) and carries one line of words under it. */
    const G = guideNames();
    g.innerHTML = `
      <div class="refit-guide-card refit-guide-wide" role="dialog" aria-modal="true" aria-labelledby="refit-guide-title">
        <span class="refit-guide-kicker">BUILD MODE · QUICK GUIDE</span><h3 id="refit-guide-title">Shape your station</h3>
        <p class="refit-guide-lead">Add rooms, choose equipment, and make the space your own. When you want a repeatable workflow, connect an inbox, an agent’s bay, and an outbox.</p>
        <div class="refit-steps">
          <div class="refit-step" data-art="room">
            <span class="refit-step-n">1</span>
            <b>MAKE SPACE</b>
            <span>Choose <b>ROOM</b> and click or drag on the grid. Use <b>SURFACE</b> to change its floor.</span>
          </div>
          <div class="refit-step" data-art="bay">
            <span class="refit-step-n">2</span>
            <b>ASSIGN AN AGENT</b>
            <span>Open <b>${esc(G.tab)}</b>, press <b>1</b> (or pick <b>BAY</b> from its hotbar) and click the floor. Click it: the <b>Workflow panel</b> docks beside the floor — choose an agent and describe their step.</span>
          </div>
          <div class="refit-step" data-art="belt">
            <span class="refit-step-n">3</span>
            <b>CONNECT THE STEPS</b>
            <span><b>Drag</b> from one machine onto the next — the belt follows your pointer and lays itself (a selected machine moves onto open floor; Shift + drag always moves). Connect <b>INBOX → BAY → OUTBOX</b>; drag a belt’s middle to branch it. The bay needs an assigned agent to do the work. Drag an <b>OUTBOX onto another line’s INBOX</b> to send its finished work onward with that line’s crew and budget.</span>
          </div>
        </div>
        <p class="refit-guide-foot">For a head start, open <b>${esc(G.tab)} › ${esc(G.lines)}</b> (${G.lineCount} ready-made layouts), stamp one, then assign its bays. <b>${esc(G.preview)}</b> animates the routing and runs no AI job. To test for real, click any machine on a line and use <b>STEP TEST</b> in its Workflow panel: it runs the real agents one step at a time and pauses at every hand-off so you can read or edit what moves on.</p>
        <div class="refit-guide-shortcuts"><span><b>Wheel</b> Zoom</span><span><b>Space + drag</b> Pan</span><span><b>Ctrl + Z</b> Undo</span><span><b>Click</b> Select</span><span><b>Drag a selected piece</b> Move it</span><span><b>Drag a box</b> Select several</span><span><b>Ctrl + C · V</b> Copy · paste</span><span><b>SAVE &amp; EXIT</b> Leave (or Esc twice)</span></div><button class="btn-sm refit-primary" id="refit-guide-go">START BUILDING</button>
      </div>`;
    root.appendChild(g);
    g.querySelectorAll('.refit-step').forEach(s => {
      const c = document.createElement('canvas');
      c.className = 'refit-step-art'; c.width = 384; c.height = 216;   // 3× the 128×72 display box
      s.insertBefore(c, s.firstChild);
      try { guideStepArt(c, s.dataset.art); } catch (e) { c.remove(); }   // art must never break the card
    });
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const dismiss = () => { markSeen(); if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, dismiss);   // ESC on THIS card (and only this one) is what marks the guide seen
    g.querySelector('#refit-guide-go').onclick = dismiss;
    g.addEventListener('click', e => { if (e.target === g) dismiss(); });
  }

  /* ---------- BAY agent-picker (Phase B4c): bind a docking bay to an agent — work that reaches it runs as
     that agent. Sourced from the app's agent list (opts.agents()) when present, plus a free-text agent id. */
  // is this prop a COMPUTER (PC)? — sourced from the station's CAP_PROP_MAP so the type list never drifts.
  const isPcProp = t => !!(station && typeof station.capForProp === 'function' && station.capForProp(t) === 'computer');
  /* ONE-CLICK CREW (guided workflows Phase 1): create a real agent for a role-carrying dock through
     the EXISTING creation seam — App.summonAgent, the same door the Recruitment Bay and the backend's
     crew.summon.request walk through (single source of agents; never a parallel mint). The spec rides
     the role's real Specialties class (loadout: model tier pin, effort, skill package), with the
     purpose LED by the dock's own duty line (the roleDesc) so the agent knows which station line it
     crews. Model: summonAgent inherits the hero's/station-default model unless the Commander pinned
     the class tier in SETTINGS — exactly the summon default everywhere else. */
  function summonForRole(role, ri) {
    if (typeof App === 'undefined' || !App.summonAgent) return null;
    const cls = (ri && ri.cls && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(ri.cls) : null;
    const duty = 'You crew this station line as its ' + role + ' — you ' + ((ri && ri.desc) || 'work this dock') + '.';
    const spec = Object.assign({}, cls || { name: role, model: 'balanced' });
    spec.purpose = duty + (cls && cls.purpose ? '\n\n' + cls.purpose : '');
    // a role that borrows another class (TESTER rides the reviewer class) names its recruit for the STEP — the button said
    // "a new tester" — through the creation-time name key, so the class still drives the specialty and the id
    if (ri && ri.name) spec.agentName = ri.name;
    try { return App.summonAgent(spec, { activate: false, desk: true }); } catch (e) { return null; }
  }
  /* ---------- THE STEP CARD (workflow studio, 2026-08-05) ----------
     ONE surface per dock, on the inspect seam: THE STEP (which stage of which line this is), THE AGENT
     (who crews it — the summon/roster/free-id machinery of the old BAY picker folded in, one surface
     instead of two hops), THE WORK (the dock's standing JOB BRIEF — what this step does with arriving
     work). The brief persists on the prop (worldmodel.setPropBrief -> migrate() whitelist), compiles
     into the posted plan (pipeline bays/dockBays.brief) and is injected into entry runs + chain
     handoffs by the sidecar (router.stageBrief). PROMPT TEXT ONLY — a brief never changes who runs or
     what tools they hold; routing and capability come from the binding and the room, untouched. */
  // the LINE a prop belongs to (valComps membership from the CURRENT compiled geometry), or null
  function lineOfProp(propId) {
    return (valComps && valComps.find(c => c.props.indexOf(propId) >= 0)) || null;
  }
  // a line's saved display name: the intake's `label` (line naming rides the INTAKE prop), or null
  /* a line as every surface names it, by one of its INBOXes (worldmodel.lineName — its first named INBOX, else LINE <its first
     INBOX's letter>: final floor lane, one name everywhere). An INBOX on no line yet keeps its own label / letter. Takes the INBOX
     prop, its id, or a connectionPreview / ring-rule entry ({ propId, label } — repair: the placement ghost read entry.id, which
     those entries do not carry, and said "WILL CONNECT TO LINE null"). */
  function lineWordOf(ip) {
    const id = ip == null ? null : typeof ip === 'object' ? (ip.id != null ? ip.id : ip.propId) : ip;
    const nm = id != null && station && station.lineName ? station.lineName(id) : null;
    if (nm) return nm;
    const lt = id != null && station && station.lineLetter ? station.lineLetter(id) : null;
    return Pipeline.lineWord(ip && typeof ip === 'object' ? ip.label : null, lt ? 'LINE ' + lt : 'THIS LINE');
  }
  function lineNameOf(c) {
    if (!c) return null;
    for (const iid of c.intakes) { const ip = station.propById(iid); if (ip && ip.label) return ip.label; }
    return null;
  }
  /* REFIT-WORKFLOW-PURE-BEGIN */
  // A graph readout, not a guessed linear sequence: branching and loops retain their real edges.
  function workflowReadout(comp, plan, nameOf) {
    const bays = (comp && comp.bays) || [];
    const chains = (plan && plan.chains) || {};
    const names = id => String(nameOf(id) || id);
    // PER DOCK (multi-bay, 2026-09-22): a step is a BAY — the writer's two bays are two steps with their own
    // onward route. A plan without the dock layer keeps the agent reading.
    const dch = (plan && plan.dockChains) || null, aod = (plan && plan.agentOfDock) || {}, rd = (plan && plan.reachDock) || null;
    const recOf = b => b.agentId ? (dch ? dch[b.propId] : chains[b.agentId]) : null;
    const steps = bays.map(b => {
      const ch = recOf(b);
      const destinations = ch ? (ch.next || []).map(n => names(dch ? (aod[n] || n) : n)) : [];
      if (ch && ch.outbox) destinations.push('Results outbox');
      if (ch && ch.deadEnd) destinations.push('Disconnected end — connect a destination');
      return { propId: b.propId, label: b.role || (b.agentId ? names(b.agentId) : 'Unassigned step'),
        agent: b.agentId ? names(b.agentId) : 'Choose an agent',
        receives: b.agentId && plan && (rd ? rd[b.propId] : (plan.reach && plan.reach[b.agentId])) ? 'Receives incoming work' : '',
        sends: destinations.length ? destinations.join(' / ') : 'No confirmed onward route' };
    });
    const exits = bays.filter(b => { const ch = recOf(b); return !!(ch && ch.outbox); }).length;
    return { steps,
      start: comp && comp.intakes.length ? 'Inbox — configure what starts this workflow below' : 'No inbox on this line',
      result: exits ? 'Connected to a results outbox' : 'No confirmed route to an outbox',
      compact: (comp && comp.intakes.length ? 'Inbox' : 'No inbox') + ' → ' + bays.length + ' step' + (bays.length === 1 ? '' : 's') + ' → ' + (exits ? 'Outbox' : 'Check output route') };
  }
  /* REFIT-WORKFLOW-PURE-END */
  /* which position does this dock's agent hold on the COMPILED line? (inbox-trigger, 2026-08-05)
     'entry' = fed straight by an intake source (plan.reach — the BFS from every source), 'chain' = fed by an
     upstream dock's chain edge (plan.chains[..].next), null = unknowable (unbound dock / no compiled plan /
     a lone dock off the belt graph). Read from the SAME compiled plan the sidecar routes by — never guessed
     from geometry. reach wins when both hold: a dock intakes feed directly is an entry stage first. */
  function stepPositionOf(agentId, dockId) {
    if (!agentId || !valPlan) return null;
    // (multi-bay) a named BAY answers for itself: the writer's first bay is 'entry', its second is 'chain'
    if (dockId && valPlan.dockChains && valPlan.agentOfDock && valPlan.agentOfDock[dockId] === agentId) {
      if (valPlan.reachDock && valPlan.reachDock[dockId]) return 'entry';
      for (const d in valPlan.dockChains) if (((valPlan.dockChains[d] || {}).next || []).indexOf(dockId) >= 0) return 'chain';
      return null;
    }
    if (valPlan.reach && valPlan.reach[agentId]) return 'entry';
    const chains = valPlan.chains || {};
    for (const a in chains) { const nx = (chains[a] && chains[a].next) || []; if (nx.indexOf(agentId) >= 0) return 'chain'; }
    return null;
  }
  /* THE LINE FACTS FOLLOW THE FLOOR (2026-08-22 sweep -> 2026-09-22 docked panel). The STEP card's "ON <LINE> —
     feeds <next>" sentence became the docked Workflow panel's GETS/TO contract rows, the flow strip and the
     how-it-runs sentence; every one of them re-reads the recompiled plan here, after every floor edit, so a
     click-connect is answered on the open panel without reopening it. */
  function refreshLineFacts() {
    if (typeof WorkflowPanel !== 'undefined' && WorkflowPanel.isOpen()) WorkflowPanel.refresh();
  }
  /* THE COMPUTE RULE, SAID PLAINLY  /* THE COMPUTE RULE, SAID PLAINLY (2026-08-22 sweep): the floor's amber "NO COMPUTE — ADD A PC IN THIS ROOM"
     never said WHOSE PC — bayObjects grants `computer` only from a workstation in the bay's room that is
     assigned to THIS agent (or unassigned in a one-agent room). The card states exactly that, with the
     one-click fix: a desk placed IN THIS ROOM and bound to the agent (requisitionPcFor — the same validated
     addProp path a hand placement takes; never a flag). Reads bayObjectsMemoed — the same truth the nag draws. */
  function requisitionPcFor(bayId) {
    const p = station.propById(bayId); if (!p || !p.agentId) return { ok: false, reason: 'uncrewed' };
    const rid = station.roomAt(p.x, p.y), rm = rid && station.roomById(rid);
    if (!rm || !rm.rects) return { ok: false, reason: 'no-room' };
    for (const r of rm.rects)
      for (let y = r.y1; y <= r.y2; y++)
        for (let x = r.x1; x <= r.x2; x++) {
          if (!(station.canPlaceProp('desk', x, y, 2, 1) || {}).ok) continue;
          const res = station.addProp({ t: 'desk', x, y, w: 2, h: 1, agentId: p.agentId });
          if (!res || !res.ok) continue;
          pushFlash([{ x1: x, y1: y, x2: x + 1, y2: y }], false);
          if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced('desk');
          return { ok: true, id: res.id, tile: { tx: x, ty: y } };
        }
    return { ok: false, reason: 'no-room-for-a-desk' };
  }
  /* THE CHECKLIST FOLLOWS THE LINE YOU ARE TOUCHING (2026-08-22 sweep): with two lines on the floor the
     FINISH card stayed pinned to whichever line it first adopted. Opening any machine's card (STEP / INBOX /
     OUTBOX / junction) now focuses that machine's line — finKeySel is the same session key finPick honours —
     and re-renders, so the checklist beside the card is the checklist FOR that line. A line already finished
     (dismissed, or shipped with nothing left to do) stays quiet: finPick filters those before the key is consulted. */
  function finFocusLine(propId) {
    const c = lineOfProp(propId);
    if (c) finEngaged = true;
    if (!c || c.key === finKeySel) return;
    finKeySel = c.key; finSig = '';
    if (running) renderFinCard();
  }
  /* ---------- THE DOCKED WORKFLOW PANEL (2026-09-22 — Andrew: "a docked panel, not a modal") ----------
     The BAY's step card and the INBOX/gate flow card were modals over the floor ("puts the user in a box").
     Both doors keep their names — the floor click, FINISH ① CREW, the world's NO AGENT nag, EDIT STEPS all
     still call openStepCard / openFlowCard — but they now open ONE panel docked beside the floor
     (frontend/app/workflowpanel.js) with that part selected. The floor stays live: selecting a part in the
     panel highlights + pans to it here, and clicking a machine here selects it there. Every capability the
     two cards had moved into the panel, reorganized (simplify = organization, never removal). */
  function openStepCard(bayId, ev) {
    if (!root) return;
    const p = station.propById(bayId); if (!p || p.t !== 'bay') return;
    cardCloseAll();   // a modal that was up (a room card, the belt card) gives way — the panel never covers the floor
    finFocusLine(bayId);
    openWorkflowPanel(bayId);
  }
  /* JOIN A LINE (2026-10-09 P0 — the Workflow panel of a BAY on no line): the BELT tool arms with THIS bay already chosen as the
     destination, the Build Library staying minimized beside the panel; the next machine clicked on the floor is the one that hands
     it work (onDown, connectTo). The floor captions the armed BAY "TO ▸ …" and previews each lane before the click. */
  function armJoin(bayId) {
    const p = station && station.propById(bayId);
    if (!p || p.t !== 'bay') return false;
    selectTool('belt', { keepKit: true, silent: true });
    connectTo = bayId;
    sfx('click');
    return true;
  }
  function openWorkflowPanel(propId, fromFloor) {
    if (typeof WorkflowPanel === 'undefined' || !root) return;
    WorkflowPanel.open(wfHost(), propId, { fromFloor: !!fromFloor });
  }
  // the machines a line is made of — clicking one on the floor opens/selects it in the panel
  const WF_PART = { bay: 1, intake: 1, outbox: 1, loop: 1, joiner: 1, merger: 1, splitter: 1 };
  let wfHighlightId = null, wfPaused = null, wfHostMemo = null, wfKitAuto = false;   // wfKitAuto: the panel minimized the Build Library (and owes it back)
  let wfShownPart = null;   // the part the panel last showed (its close-time highlight(null) leaves it): the line DONE keeps clear of the library
  let wfArtRev = -1, wfArtAt = 0;   // the authored-art revision the panel's tiles were last painted at (frame(): repaint when it moves)
  /* the HOST the panel is handed: live reads of THIS editor's state (station, compiled plan, camera) and the
     seams it already owns (sample, plan gate, flash/sfx). Lazy getters — the panel never caches a plan. */
  function wfHost() {
    if (wfHostMemo) return wfHostMemo;
    wfHostMemo = {
      root: () => root, station: () => station, plan: () => valPlan, comps: () => valComps || [], geo: () => cacheGeo,
      lineOfProp, lineNameOf, stampName: id => stampNameOf[id] || null, stationKey: () => stationKeyOf(station),
      agents: () => (opts && typeof opts.agents === 'function' && opts.agents()) || [],
      agentLabel: agentLabelFor, esc, sfx, flashTip: (msg, ok) => flashTip(null, msg, ok), valLabel: valWhy,
      roleInfo: r => (typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(r) : null,
      canSummon: () => typeof App !== 'undefined' && !!App.summonAgent, summonForRole,
      hasCompute: (aid, dockId) => !!aid && bayObjectsMemoed(aid, dockId).indexOf('computer') >= 0,   // per BAY when the caller names one
      requisitionPcFor: id => { const r = requisitionPcFor(id); if (r.ok) bumpGeo(); return r; },
      stepPositionOf,
      api: finApi, planGate: c => finPlanGate(c),
      runSample: (c, o) => finRunSample(c, o), sampleState: () => finSampleRes, sampleHTML: v => finSampleHTML(v),
      stopSample: () => finStopSample(),   // ■ STOP on RUN ONE REAL JOB: this job only (E-STOP stops the station)
      feedState: () => (opts && opts.world && opts.world.feedState) ? opts.world.feedState() : { known: false, fed: false },
      pollFeed: () => { try { return Promise.resolve(opts && opts.world && opts.world.pollFeed && opts.world.pollFeed()); } catch (e) { return Promise.resolve(); } },
      human: d => { const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
        return (typeof CronHuman !== 'undefined' && CronHuman.describeDisplay) ? CronHuman.describeDisplay(d, { tz }) : String(d == null ? '' : d); },
      provider: () => (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined,
      openTerm: name => { close(); if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm(name); },
      highlight: id => { wfHighlightId = id || null; if (id) wfShownPart = id; },
      joinLine: id => armJoin(id),   // JOIN A LINE: BELT armed with this BAY as the destination (onDown's connectTo)
      focusProp: (id, onlyIfHidden) => focusPropOnFloor(id, onlyIfHidden),
      frameLine: key => frameLineOnFloor(key),
      pausedMarker: m => { wfPaused = m || null; },
      layoutChanged: () => { bumpUi(); insMemo = null; },
      /* TWO PANELS SQUEEZE THE FLOOR (Andrew, 2026-09-22): opening the docked Workflow panel MINIMIZES the Build
         Library through its own MINIMIZE state (toggleKit), and closing the panel restores it — only if the
         panel was the one that minimized it, and only if the Commander has not reopened it since (toggleKit
         clears wfKitAuto on any reopen, so a deliberate OPEN KIT is never overridden). The library it gives back must not land
         on the line the panel was showing: the glass is measured while the library is still minimized, and keepClearOfKit moves
         the camera only when the returning library covers what was on it (0.13.5 live, s1-hand r05b). */
      panelShown: on => {
        const dock = root && root.querySelector('.refit-dock');
        if (on) { if (dock && !dock.classList.contains('is-collapsed')) { toggleKit(true); wfKitAuto = true; } }
        else {
          const restore = wfKitAuto, part = wfShownPart, seen = restore && running ? viewInsets() : null;   // (BUILD MODE closing: running is already false)
          wfKitAuto = false; wfShownPart = null;
          if (restore && dock && dock.classList.contains('is-collapsed')) toggleKit(false);
          if (seen) keepClearOfKit(part, seen);
        }
        bumpUi(); insMemo = null;
      },
      lineRenamed: () => { if (running) { finSig = ''; renderFinCard(); } },
      /* a junction's compiled cfg + where each of its out-belts leads, for the panel's SPLITTER / FILTER sections (2026-09-27 audit
         P1/P4): the same compiled plan the floor tags read, the same lane labels the loop's DONE picker uses */
      junctionInfo: id => {
        const p = station.propById(id); if (!p) return null;
        const jt = junctionBeltTile(p), o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
        const lk = jt ? (jt.x - o.tx) + ',' + (jt.y - o.ty) : null;
        const cfg0 = (lk && valPlan && valPlan.junctions) ? (valPlan.junctions[lk] || null) : null;
        const cfg = cfg0 && cfg0.kind === 'split' ? Object.assign({}, cfg0, { fanout: !!fanoutOnceCrewed()[lk] }) : cfg0;
        const dirs = jt ? junctionOutLanes(jt.x, jt.y) : [];
        const labels = jt ? loopExitLabels(valPlan, { x: jt.x - o.tx, y: jt.y - o.ty }, agentLabel) : [];
        // the compass prefix ("E → ") is builder shorthand; the panel names the belt by where it goes
        const plain = t => String(t || '').replace(/^[NSEW]\s*\S\s+/, '');
        return { cfg, lanes: dirs.map(d => { const ex = labels.find(x => x.dir === d) || {};
          return { dir: d, dock: ex.dock || null, label: plain(ex.label) || ('the ' + ({ N: 'north', S: 'south', E: 'east', W: 'west' }[d] || d) + ' belt') }; }) };
      },
      machineDiagram: id => machineDiagramSVG(id),
      machineStill: type => machineStill(type),          // a part's own floor art, for the panel's line diagram
      bayLive: id => (opts.world && opts.world.bayLive) ? opts.world.bayLive(id) : null,   // a bay's live lamp state (WORKING / WAITING …)
      preview: () => sendTestBoxes(null),               // the TEST view's WATCH IT: the free walkthrough on the floor
      splitModeInfo: id => splitModeInfo(id),            // { mode: 'copy'|'turns', toCopy, toTurns } — the SPLITTER switch
      setSplitMode: (id, mode) => setSplitMode(id, mode), // swaps the JOINER/MERGER where the branches meet (one undo)
      loopExits: id => {
        const p = station.propById(id), jt = p && junctionBeltTile(p), o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
        return jt ? loopExitLabels(valPlan, { x: jt.x - o.tx, y: jt.y - o.ty }, agentLabel) : [];
      },
      loopRuleTxt, loopBackTxt,
      lineCycles: () => { let errs = []; try { errs = Pipeline.compileRoutingPlan(station.projectGeometry()).errors || []; } catch (e) { errs = []; } return errs.some(e => e.code === 'CYCLE' || e.code === 'CHAIN_CYCLE'); },
      canInsertBay: (fromId, toId) => {
        if (typeof station.canInsertBayBetween !== 'function') return { ok: true };
        const sp = propSpec('bay');   // the SAME bay insertBay places — the dry run must try the size the real insert will
        return station.canInsertBayBetween(fromId, toId, { w: sp.w, h: sp.h, block: sp.blocks !== false });
      },
      insertBay: (fromId, toId, role) => {
        if (typeof station.insertBayBetween !== 'function') return { ok: false, msg: 'this station model cannot insert a step' };
        const sp = propSpec('bay');
        const res = station.insertBayBetween(fromId, toId, { role: role || null, w: sp.w, h: sp.h, block: sp.blocks !== false });
        if (res && res.ok) { pushFlash([{ x1: res.x, y1: res.y, x2: res.x + (sp.w || 2) - 1, y2: res.y + (sp.h || 2) - 1 }], false); if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced('bay'); }
        return res;
      },
      /* LINE EDITS (conveyor-links phase D): every change the panel makes to the line's SHAPE — a step, a branch, a review
         loop, a sorter, a removal, a move, TIDY LINE — is LineEdit: the line's graph edited, laid out by the engine and
         written back in ONE undo slot (lineEditRun). canLineEdit answers without laying anything, so a button that could
         only fail is shown off with its reason. */
      lineEdit: (op, propId, args, how) => lineEditRun(op, propId, args, how),
      canLineEdit: (op, propId, args) => (typeof LineEdit === 'undefined' || !station) ? { ok: false, msg: 'the line editor is not loaded' } : LineEdit.check(station, propId, op, args, { sizes: lineSizes() }),
    };
    return wfHostMemo;
  }
  /* LINE EDITS — the catalog's machine sizes, the tile in the middle of the visible glass (where a NEW line is laid), and the
     one runner every edit goes through: the machines it placed flash, the tutorial hears them, and the plan is recompiled at
     once so the panel repaints on the edited line (not on the next frame's) */
  const lineSizes = () => { const s = t => { const sp = propSpec(t); return [sp.w || 2, sp.h || 2]; }; return { bay: s('bay'), intake: s('intake'), outbox: s('outbox') }; };
  function viewCenterTile() {
    if (!cv) return null;
    const t = T(), ins = viewInsets();
    const vw = Math.max(1, cv.width - ins.l - (ins.r || 0)), vh = Math.max(1, cv.height - ins.t - ins.b);
    return { x: Math.floor((ins.l + vw / 2 - panX) / zoom / t), y: Math.floor((ins.t + vh / 2 - panY) / zoom / t) };
  }
  function lineEditRun(op, propId, args, how) {
    if (typeof LineEdit === 'undefined' || !station) return { ok: false, msg: 'the line editor is not loaded' };
    // where the line's machines stood before the edit (so the floor can show what moved and what went)
    const before = {};
    try {
      const g0 = propId != null ? station.lineGraph(propId) : null;
      if (g0 && g0.ok) for (const n of g0.graph.nodes) before[n.id] = { x1: n.pin.x, y1: n.pin.y, x2: n.pin.x + (n.w || 1) - 1, y2: n.pin.y + (n.h || 1) - 1 };
    } catch (e) { /* (only the courtesy flash depends on it) */ }
    const res = LineEdit.run(station, propId, op, args, { near: viewCenterTile(), sizes: lineSizes(), tidy: !!(how && how.tidy) });
    if (res && res.ok) {
      const placed = Object.keys(res.ids || {}).filter(k => k.charAt(0) === '+').map(k => station.propById(res.ids[k])).filter(Boolean);
      if (placed.length) pushFlash(placed.map(p => ({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 })), false);
      // WHAT MOVED, WHAT WENT: a machine the edit moved glides an outline from where it stood to where it stands (the floor
      // re-bakes at once — the glide is that jump made visible); one it took out flashes red where it was
      const moves = [];
      for (const id in before) {
        const p = station.propById(id), b = before[id];
        if (p && (p.x !== b.x1 || p.y !== b.y1)) moves.push({ from: b, to: { x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 } });
      }
      if (moves.length) pushMoves(moves);
      const gone = (res.removed || []).map(id => before[id]).filter(Boolean);
      if (gone.length) pushFlash(gone, true);
      if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) for (const p of placed) Tutorial.onPropPlaced(p.t);
      try { rebake(); } catch (e) { /* the frame loop compiles on its next tick; the panel repaints when it does */ }
    }
    return res;
  }
  /* pan the floor so a part sits in the middle of the VISIBLE glass (clear of the kit dock and the panel) */
  function focusPropOnFloor(id, onlyIfHidden) {
    const p = id && station && station.propById(id);
    if (!p || !cv) return;
    const t = T(), ins = viewInsets();
    const vw = Math.max(1, cv.width - ins.l - (ins.r || 0)), vh = Math.max(1, cv.height - ins.t - ins.b);
    const cx = (p.x + (p.w || 1) / 2) * t, cy = (p.y + (p.h || 1) / 2) * t;
    if (onlyIfHidden) {   // a floor click: leave the camera alone unless the panel now covers what was clicked
      const sx = cx * zoom + panX, sy = cy * zoom + panY;
      if (sx >= ins.l && sx <= cv.width - (ins.r || 0) && sy >= ins.t && sy <= cv.height - ins.b) return;
    }
    panX = ins.l + vw / 2 - cx * zoom;
    panY = ins.t + vh / 2 - cy * zoom;
  }
  /* frame a whole LINE in the visible glass when any of it sits behind the panel / kit (the panel just docked
     over it). Pans to the line's centre; zooms out only as far as it must to fit, never in. */
  function frameLineOnFloor(key) {
    const c = valComps && valComps.find(x => x.key === key);
    if (!c || !c.bbox || !cv || !cacheGeo) return;
    const t = T(), o = cacheGeo.origin || { tx: 0, ty: 0 }, ins = viewInsets();
    const x1 = (c.bbox.x1 + o.tx) * t, y1 = (c.bbox.y1 + o.ty) * t, x2 = (c.bbox.x2 + 1 + o.tx) * t, y2 = (c.bbox.y2 + 1 + o.ty) * t;
    const L = ins.l, R = cv.width - (ins.r || 0), Tp = ins.t, B = cv.height - ins.b;
    if (x1 * zoom + panX >= L && x2 * zoom + panX <= R && y1 * zoom + panY >= Tp && y2 * zoom + panY <= B) return;
    const vw = Math.max(1, R - L), vh = Math.max(1, B - Tp), pad = 3 * t;
    zoom = clamp(Math.min(zoom, vw / (x2 - x1 + pad * 2), vh / (y2 - y1 + pad * 2)), MINZ, MAXZ);
    panX = L + vw / 2 - (x1 + x2) / 2 * zoom;
    panY = Tp + vh / 2 - (y1 + y2) / 2 * zoom;
  }
  /* DONE KEEPS THE LINE IN VIEW (0.13.5 live, s1-hand r05/r05b). The panel framed its line against the MINIMIZED library, so
     closing it (✓ DONE, ✕, Escape) brought the library back open on top of the INBOX + BAY just edited, and the Commander had to
     FIT or pan to reach them. When the library returns, the floor follows only what the library itself hides:
       · some of the line was on the glass a moment ago (library still minimized: `seen`) and the returning library now covers part
         of that → frame the line in the glass beside it (frameLineOnFloor: pan to its centre, zoom out only if it must, never in);
       · a line already clear of the library is never moved;
       · a line the Commander panned off the glass while the panel was open stays where they put it (the library hid none of it).
     A part on no line yet (a lone BAY) gets the same rule on its own footprint. A CAMERA MOVE ONLY — panX/panY/zoom: no bake, no
     geometry, no plan; the frame loop fills any newly visible chunks exactly as it does for a hand pan. */
  function keepClearOfKit(partId, seen) {
    const p = partId != null && station ? station.propById(partId) : null;
    if (!p || !cv) return;
    const c = lineOfProp(p.id), t = T(), o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
    const b = c && c.bbox && cacheGeo
      ? { x1: (c.bbox.x1 + o.tx) * t, y1: (c.bbox.y1 + o.ty) * t, x2: (c.bbox.x2 + 1 + o.tx) * t, y2: (c.bbox.y2 + 1 + o.ty) * t }
      : { x1: p.x * t, y1: p.y * t, x2: (p.x + (p.w || 1)) * t, y2: (p.y + (p.h || 1)) * t };
    const W = cv.width, H = cv.height, ins = viewInsets();
    // the part of it that was on the glass with the library minimized (canvas px)
    const x1 = Math.max(b.x1 * zoom + panX, seen.l), x2 = Math.min(b.x2 * zoom + panX, W - (seen.r || 0));
    const y1 = Math.max(b.y1 * zoom + panY, seen.t), y2 = Math.min(b.y2 * zoom + panY, H - seen.b);
    if (x1 >= x2 || y1 >= y2) return;   // none of it: the Commander had moved the floor away — leave it there
    if (x1 >= ins.l && x2 <= W - (ins.r || 0) && y1 >= ins.t && y2 <= H - ins.b) return;   // the library lands on none of it
    if (c && c.bbox && cacheGeo) frameLineOnFloor(c.key); else focusPropOnFloor(p.id);
  }
  /* the panel's floor marks: the selected part pulses gold; a PAUSED step test parks a pulsing marker on the
     finished dock's OUTBOUND tile (plan.chains[agent].tile — the tile its product really ships from). The
     BUILD MODE conveyor cannot hold a real crate mid-belt, so no crate is drawn riding: only where it waits. */
  function drawWorkflowMarks(t, now) {
    if (wfHighlightId) {
      const p = station.propById(wfHighlightId);
      if (p) drawPropSelection(p, t, 'rgba(255,211,74,' + (0.55 + 0.35 * Math.sin(now / 260)).toFixed(2) + ')');
    }
    if (!wfPaused || !valPlan || !cacheGeo) return;
    // (multi-bay) the marker names the BAY the paused hop ran at — its own ship tile, never the agent's other bay
    const ch = (wfPaused.dockId && valPlan.dockChains && valPlan.dockChains[wfPaused.dockId]) || (valPlan.chains && valPlan.chains[wfPaused.agentId]);
    if (!ch || !ch.tile) return;
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, x = (ch.tile.x + o.tx) * t, y = (ch.tile.y + o.ty) * t;
    const k = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.save();
    ctx.strokeStyle = 'rgba(95,216,255,' + (0.45 + 0.5 * k).toFixed(2) + ')'; ctx.lineWidth = 2 / zoom;
    const pad = (2 + 2 * k) / zoom * 2;
    ctx.strokeRect(x - pad, y - pad, t + pad * 2, t + pad * 2);
    // what waits here is the step's RESULT: the same crate that rides the belts, parked on the tile it ships from
    if (typeof Conveyor !== 'undefined' && Conveyor.drawCrate) Conveyor.drawCrate(ctx, Math.round(x + t / 2), Math.round(y + t / 2) + 1, 'product');
    ctx.restore();
    const label = wfPaused.label || 'HANDOFF WAITING';
    const box = captionBox(label, x + t / 2, 0, y + t + 6 / zoom);   // under the tile: the dock's nameplate owns the space above
    voiceSay('activeFlow', { x, y, w: t, h: t }, box, c => captionPlate(c, label, box, '#5fd8ff'));
  }

  /* ---------- WHO SITS AT THIS DESK (2026-10-07, Andrew: "SO SO SO CONFUSING" — replaces the CONFIGURE → modal picker).
     A workstation carries an agentId exactly like a bay does (assignPropAgent is type-agnostic); world.js seats the agent
     at the FIRST workstation bound to it (deskPropFor). So giving an agent this desk must also take it off any OTHER
     workstation it holds — otherwise it keeps walking to the old one and the click looked like it did nothing. One
     transaction = one UNDO. The choice lives IN the selected-object card (renderSelection), one click per agent.
     The rule itself is the station's (worldmodel.js assignDesk), shared with the overseer's station-control 'agent' op. */
  function assignDesk(propId, aid) {
    return station.assignDesk(propId, String(aid || ''));
  }
  // the agent a "PLACE ITS DESK" door is placing a desk FOR (placeDeskFor) — the next workstation dropped is theirs
  let deskOwner = null;
  function sitsRow(p) {
    const agents = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const box = document.createElement('div'); box.className = 'refit-sel-sits';
    const k = document.createElement('div'); k.className = 'refit-sel-sits-k'; k.textContent = 'WHO SITS HERE';
    const row = document.createElement('div'); row.className = 'refit-sel-sits-row';
    box.append(k, row);
    if (!agents.length) { const n = document.createElement('small'); n.textContent = 'No crew yet — recruit an agent, then pick it here'; row.append(n); }
    const chip = (label, aid, tip) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bb sm refit-sit' + ((p.agentId || '') === aid ? ' active' : '');
      b.setAttribute('aria-pressed', String((p.agentId || '') === aid)); b.textContent = label; if (tip) b.setAttribute('data-tip', tip);
      b.onclick = () => {
        if ((p.agentId || '') === aid) return;
        const res = assignDesk(p.id, aid);
        feedback(res, orientEv(), aid ? (agentLabel(aid) + ' sits here now') : 'nobody sits here now');
        renderSelection();
      };
      row.append(b);
    };
    for (const a of agents) {
      const other = station.propsByAgent(a.id).some(q => q.id !== p.id && WORKSTATION_TYPES[q.t]);
      chip(a.name || a.id, a.id, other && a.id !== p.agentId ? (a.name || a.id) + ' moves here from its other desk' : '');
    }
    if (p.agentId) chip('NOBODY', '');
    return box;
  }
  // a double-click / openAssign on a workstation: select it — its card IS the picker now
  function openWorkstationPicker(propId) {
    const p = station.propById(propId); if (!p || !WORKSTATION_TYPES[p.t]) return;
    cardCloseAll();
    selBelts = null; groupIds = []; selectedRoomId = null; selectedPropId = propId; renderSelection();
    setHint('Selected ' + propLabel(p.t) + ' · pick who sits here');
  }
  /* PLACE ITS DESK (the deskless-agent door in COMMS → App.openDeskPlacement). It used to drive the palette by clicking
     DOM tabs that the 10-01 library rebuild renamed, so it often armed nothing, and the desk it did place belonged to
     NOBODY — the agent still had nowhere to sit until the Commander found CONFIGURE. Now it arms a workstation for that
     agent: the very next floor click drops the desk AND seats them there. */
  function placeDeskFor(agentId) {
    if (!running) open();
    if (!station) return false;
    deskOwner = String(agentId || '') || null;
    if (!WORKSTATION_TYPES[propType]) propType = 'desk';
    const spec = catalog().find(c => c.id === propType);
    if (spec) { propSection = sectionOf(spec); propAbility = propSection === 'abilities' ? capOf(spec) : ''; }
    propCat = 'all'; propQuery = '';
    selectTool('prop', { silent: true });
    return true;
  }
  // the desk that click drops: added, then seated through the same one-desk rule as the chips (station.assignDesk),
  // all in one transaction — one UNDO takes back the desk AND the move, and a refused drop changes nothing
  function addOwnedDesk(placement, owner) {
    return station.transact(() => {
      const added = station.addProp(placement);
      if (!added || !added.ok) return added;
      const seat = station.assignDesk(added.id, owner);
      return seat && seat.ok ? added : seat;
    });
  }

  /* ---------- FILTER junction editor (Polish P1): make content-routing reachable from the UI.
     A FILTER wants routes (tag -> out-lane) + a default lane — a missing default is an amber nag
     (FILTER_NO_DEFAULT, warn: unrouted work falls back def -> first lane, never dropped);
     it calls station.configureJunction. Opens on place/click.
     A MERGER has NO editor — like the splitter, it is pure topology. It used to offer a "combine K" field
     for a hold-K-then-emit-one barrier the harness never performed (see conveyor.js chooseExit), so the
     control was authoring a promise nothing could keep. A merger clicks through to the flow card instead. */
  const J_DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  const J_OPP = { E: 'W', W: 'E', S: 'N', N: 'S' };
  const J_LANES = ['E', 'S', 'W', 'N'];   // fixed order — mirrors pipeline.js / conveyor.js
  const J_ARROW = { E: '→ E', S: '↓ S', W: '← W', N: '↑ N' };
  // the out-lanes leaving this tile: neighbouring belts that don't flow back in (where work can exit)
  function junctionOutLanes(tx, ty) {
    const out = [];
    for (const d of J_LANES) { const v = J_DIRV[d], nb = station.beltAt(tx + v[0], ty + v[1]); if (nb && nb !== J_OPP[d]) out.push(d); }
    return out;
  }
  /* the belt tile a junction prop ATTACHES to — the SAME semantics as the compiler (pipeline.js
     compileRoutingPlan): the prop's own tile if it sits on a belt, else the first belt tile in its
     footprint + 1-tile ring, in the compiler's exact scan order (y then x, from (x-1,y-1)). Before this
     the editor computed lanes at the prop's own tile only, so a ring-attached filter (e.g. nudged one
     tile off its lane by MOVE) still COMPILED and routed, while its editor showed "lay belts OUT of this
     filter first" with zero lane buttons — an error the Commander could not fix. Returns {x,y} or null. */
  function junctionBeltTile(p) {
    if (station.beltAt(p.x, p.y)) return { x: p.x, y: p.y };
    const w = p.w || 1, h = p.h || 1;
    for (let yy = p.y - 1; yy <= p.y + h; yy++)
      for (let xx = p.x - 1; xx <= p.x + w; xx++)
        if (station.beltAt(xx, yy)) return { x: xx, y: yy };
    return null;
  }
  // Each editor explains the clicked prop. Actual connections are shown in context,
  // never as a generic diagram that implies extra props or a fixed workflow shape.
  function workflowIntroHTML(kicker, title, description) {
    return '<header class="workflow-header"><div><span class="workflow-kicker">' + esc(kicker) + '</span>'
      + '<h3 id="workflow-title">' + esc(title) + '</h3><p>' + esc(description) + '</p></div>'
      + '<button type="button" class="bb workflow-close" data-workflow-close aria-label="Close setup">✕</button></header>';
  }
  /* REFIT-JUNCTION-PURE-BEGIN (extraction marker — test/refit-junction-cards.test.js evals this block with
     injected deps; PURE: params + locals only, no module state, no DOM). The LOOP card's lane labels and the
     FINISH card's sample readout are both "what does this do / did that work?" answers, and an answer that
     lives only inside a browser IIFE is an answer no test can hold to the truthful-telemetry law. */
  /* loopRuleTxt(when, max) -> the ONE loop rule in the words the sidecar runs it by (routing/chain.js, 2026-08-22).
     PURE. The card, the saved-note and the gate agree because they all read this. */
  function loopRuleTxt(when, max) {
    const n = max || 5, passes = n + ' pass' + (n === 1 ? '' : 'es');
    if (when === 'approved' || when === 'revise') {
      return 'goes round until the reviewer’s last line says VERDICT: ' + when + ' (the reviewer is told to end with one; no verdict = round again), or MAX PASSES (' + passes + ') — then leaves on DONE marked unapproved.';
    }
    if (when) return 'goes round again ONLY while the reviewer’s output reads as ' + when.toUpperCase() + ' work; anything else leaves on DONE. MAX PASSES (' + passes + ') ends it regardless.';
    return 'no verdict picked: every pass goes round until MAX PASSES (' + passes + ') is spent, then leaves on DONE.';
  }
  /* a LOOP gate's exits, labelled by DIRECTION and by WHAT THEY LEAD TO — read off the compiled plan (local
     frame), never guessed from geometry. Walks each out-lane along the belts to the first machine it meets:
     a dock (-> "to WRITER"), an OUTBOX mouth (-> "OUTBOX"), another junction (-> "a FILTER"), its own tile
     again (-> "round again"), or nothing (-> "nowhere yet"). `nameOf(agentId)` supplies display names. */
  function loopExitLabels(plan, tile, nameOf) {
    const out = [];
    if (!plan || !plan.belts || !tile) return out;
    const DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }, OPP = { E: 'W', W: 'E', S: 'N', N: 'S' };
    const map = plan.belts, bayAt = plan.bayTileToAgent || {}, junctions = plan.junctions || {};
    const dockAt = plan.bayTileToDock || {}, emptyAt = plan.unboundBayTile || {};   // which BAY a lane lands on — crewed or not
    const outs = {}; for (const o of (plan.outs || [])) if (o && o.tile) outs[o.tile.x + ',' + o.tile.y] = true;
    const KIND = { split: 'SPLITTER', merge: 'MERGER', join: 'JOINER', loop: 'LOOP', filter: 'FILTER' };
    const home = tile.x + ',' + tile.y;
    for (const d of ['E', 'S', 'W', 'N']) {
      const v = DIRV[d], nb = map[(tile.x + v[0]) + ',' + (tile.y + v[1])];
      if (!nb || nb === OPP[d]) continue;                       // not an out-lane (no belt, or it flows back in)
      let t = { x: tile.x + v[0], y: tile.y + v[1] }, to = 'nowhere yet', kind = 'none', guard = 0, dock = null;
      const seen = {};
      while (t && guard++ < 4096) {
        const k = t.x + ',' + t.y;
        if (k === home) { to = 'round again'; kind = 'self'; break; }
        if (bayAt[k]) { to = 'to ' + String(nameOf ? nameOf(bayAt[k]) : bayAt[k]).toUpperCase(); kind = 'bay'; dock = dockAt[k] || null; break; }
        // a BAY with no agent yet is still where the belt goes (2026-09-28 retest: a fresh split read "nowhere yet" twice)
        if (emptyAt[k]) { to = 'to a BAY with no agent yet'; kind = 'bay'; dock = emptyAt[k]; break; }
        if (outs[k]) { to = 'OUTBOX'; kind = 'outbox'; break; }
        if (junctions[k]) { to = 'a ' + (KIND[junctions[k].kind] || 'JUNCTION'); kind = 'junction'; break; }
        if (seen[k]) break;
        seen[k] = true;
        const dir = map[k]; if (!dir) break;                    // hookups + mouths are belt tiles, so off-belt = the lane ends
        const w = DIRV[dir]; t = { x: t.x + w[0], y: t.y + w[1] };
      }
      out.push({ dir: d, to: to, kind: kind, dock: dock, label: d + ' → ' + to });
    }
    return out;
  }
  // the sentence under the DONE picker: which exit is the BACK lane (the other one) and where it re-enters
  function loopBackTxt(exits, done) {
    const back = (exits || []).find(x => x.dir !== done) || null;
    if (!back) return 'no BACK lane yet — the gate needs a second exit that leads upstream, or nothing goes round';
    if (back.kind === 'bay') return 'BACK lane: ' + back.label + ' — work goes back there for another pass';
    return 'BACK lane: ' + back.label + ' — a back lane must lead to an upstream dock';
  }
  /* the sample run's readout — ONLY what the server's answer proves. `resp` = the parsed JSON of
     POST /api/routing/sample (200 or 502 carry the same fields; a 409 carries only {ok,error}); `status`
     = the HTTP status; `nameOf(agentId)` = display name. Returns { ok, stages:[names], usd, reply, reason }:
     stages = the recorded runs in line order (the route lists them newest-first), usd = the summed real
     cost, reply = the first ~80 chars of what the line delivered (the last stage's reply). */
  function sampleResultView(resp, status, nameOf) {
    const r = (resp && typeof resp === 'object') ? resp : {};
    const runs = Array.isArray(r.runs) ? r.runs.slice().reverse() : [];
    const stages = runs.map(x => String(nameOf ? nameOf(x.agentId) : x.agentId)).filter(Boolean);
    const usd = (typeof r.totalUsd === 'number' && isFinite(r.totalUsd)) ? r.totalUsd : null;
    const replies = Array.isArray(r.replies) ? r.replies : [];
    const last = replies.length ? String(replies[replies.length - 1] || '') : '';
    // (org D7 polish) SAID is a glance, not a renderer: the reply's markdown marks (## headings, **bold**, list bullets, code fences,
    // [link](url)) are dropped and its lines joined with ' · ', so the card never shows '## This week in AI 1. **Open…'
    const plain = last.replace(/```[^\n]*\n?/g, '').split('\n')
      .map(s => s.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|>)\s+/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2').replace(/`([^`]*)`/g, '$1').trim())
      .filter(Boolean).join(' · ');
    const clean = plain.replace(/\s+/g, ' ').trim();
    const reply = clean.length > 80 ? clean.slice(0, 80) + '…' : clean;
    const ok = !!r.ok && !!r.delivered;
    const reason = ok ? null : (r.error ? String(r.error) : ('sample refused (HTTP ' + (status == null ? '?' : status) + ')'));
    // stopped: the SERVER's word that the Commander stopped this job (POST /api/routing/sample/stop) — never the click's
    return { ok: ok, stages: stages, usd: usd, reply: reply, reason: reason, stopped: !ok && r.stopped === true };
  }
  /* REFIT-JUNCTION-PURE-END */
  function openFlowCard(propId) {
    if (!root) return;
    const p = station.propById(propId); if (!p) return;
    cardCloseAll();
    finFocusLine(propId);
    openWorkflowPanel(propId);
  }

  /* ---------- BELT-TILE INFO CARD  /* ---------- BELT-TILE INFO CARD (select mode): "where does this lane go?" ----------
     Answered from the COMPILED plan via Pipeline.routeFrom — the same fan-every-junction walk the
     hover tags and the sidecar's routing read from, so the card can never claim a destination a
     dispatch wouldn't reach. Plan coords are LOCAL (valPlan compiles from cacheGeo) → rebase the
     clicked WORLD tile by cacheGeo.origin before asking. */
  function openBeltCard(tx, ty, ev) {
    if (!root) return;
    cardCloseAll();
    const dir = station.beltAt(tx, ty);
    if (!dir) return;
    const o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
    const r = (valPlan && typeof Pipeline !== 'undefined' && Pipeline.routeFrom)
      ? Pipeline.routeFrom(valPlan, tx - o.tx, ty - o.ty) : null;
    const DIRWORD = { E: 'EAST ▸', W: '◂ WEST', N: '▴ NORTH', S: '▾ SOUTH' };
    const li = [];
    // A LINKED FLOOR says which connection this belt is — or that it is LOOSE: it joins no two machines, so it is in
    // no plan and nothing rides it (conveyor-links phase B; the plan's belts are its links' paths)
    const loose = linkedFloor() && !!valPlan && !!valPlan.belts && !valPlan.belts[(tx - o.tx) + ',' + (ty - o.ty)];
    // the connections riding this tile: { from, to, ids } per from ▸ to pair — two or more get one REMOVE key each (build-17). Two
    // that read the same (two uncrewed BAYs, two BAYs one agent crews) say which side of the shared run each is on (FROM ▴ NORTH —
    // connSide), else BELT 1 / BELT 2; and pointing at a key lights the tiles only its belt rides, the floor showing through the card
    // (wave 2 repair: two identical keys left the Commander guessing which connection goes)
    const conns = (linkedFloor() && !loose) ? connsAt(tx, ty) : [];
    const words = conns.map(c => String(machineName(c.from)).toUpperCase() + ' ▸ ' + String(machineName(c.to)).toUpperCase());
    const alike = i => conns.filter((o, j) => j !== i && words[j] === words[i]);
    const sides = conns.map((c, i) => alike(i).length ? connSide(c, alike(i)) : null);
    const tag = conns.map((c, i) => {
      if (!alike(i).length) return '';
      const group = conns.map((o, j) => j).filter(j => words[j] === words[i]);
      const clear = group.every(j => sides[j]) && new Set(group.map(j => sides[j])).size === group.length;
      return clear ? sides[i] : String(group.indexOf(i) + 1);
    });
    // a look-alike's key is just REMOVE BELT FROM ▴ NORTH / REMOVE BELT 2 (its sentence above names the machines); the machines ride
    // along only where two groups of look-alikes would share that short key
    const short = conns.map((c, i) => tag[i] ? 'REMOVE BELT ' + tag[i] : 'REMOVE ' + words[i]);
    const keyText = short.map((k, i) => short.filter(x => x === k).length > 1 ? k + ' · ' + words[i] : k);
    conns.forEach((c, i) => li.push((!tag[i] ? 'This belt runs' : /^\d/.test(tag[i]) ? 'Belt ' + tag[i] + ' runs' : 'The belt ' + tag[i].toLowerCase() + ' runs') + ' from <b>' + esc(machineName(c.from)) + '</b> to <b>' + esc(machineName(c.to)) + '</b>.'));
    if (loose) li.push('This belt is <b>loose</b> — it joins no two machines, so nothing rides it. Drag from one machine onto the next to connect them; right-click removes this one.');
    else if (r) {
      if (r.agents.length) li.push('Work riding this lane reaches <b>' + r.agents.map(a => esc(agentLabelFor(a))).join(' + ') + '</b>.');
      if (r.unbound) li.push('It passes <b>' + r.unbound + ' uncrewed dock' + (r.unbound === 1 ? '' : 's') + '</b> — crew them or crates ride past.');
      if (r.outbox) li.push('It <b>ships out at the OUTBOX</b>.');
      if (r.deadEnd) li.push('A branch <b>dead-ends</b> — nothing consumes there.');
      if (!r.agents.length && !r.unbound && !r.outbox && !r.deadEnd) li.push('This tile isn’t on the compiled line yet — connect it to a machine.');
    } else li.push('No compiled route yet — lay the line to a machine and this card reads its destination.');
    const back = linksMemoed().some(l => (l.path||[]).some(q=>q.x===tx&&q.y===ty) && station.isBackLink && station.isBackLink(l.id));
    if(back) li.push('<b>LOOP BACK belt.</b> Removing it stops retries; the DONE exit stays. Undo restores it.');
    const g = document.createElement('div');
    g.className = 'refit-guide refit-belt-card refit-workflow-editor';
    g.innerHTML = '<div class="refit-guide-card" role="dialog" aria-modal="true" aria-labelledby="workflow-title">'
      + workflowIntroHTML('BELT · ' + (DIRWORD[dir] || dir), 'Where this belt takes work', 'Belts connect the steps in your workflow. Their direction decides where work travels next.')
      + '<div class="workflow-body"><section class="workflow-section"><h4>Connected destinations</h4><ul>' + li.map(s => '<li>' + s + '</li>').join('') + '</ul></section></div>'
      + '<div class="workflow-footer"><span>Drag a belt’s middle to branch it · Ctrl+drag reshapes it · right-click removes it.</span>'
      // one connection: REMOVE BELT; a tile two connections share: one key per connection (never a guess at which goes)
      + (conns.length > 1 ? conns.map((c, i) => '<button type="button" class="btn-sm" data-rmlink="' + i + '">' + esc(keyText[i]) + '</button>').join('')
        : '<button type="button" class="btn-sm" id="belt-remove">REMOVE BELT</button>')
      + '<button type="button" class="btn-sm refit-primary" id="belt-ok">✓ DONE</button></div></div>';
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));
    const closeP = () => { beltCardHot = null; if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    g.querySelector('[data-workflow-close]').onclick = closeP;
    const rmOne = g.querySelector('#belt-remove');
    if (rmOne) rmOne.onclick = () => { removeBeltAt(tx,ty,ev); closeP(); };   // (one connection, even one laid twice: removeBeltAt takes it whole)
    g.querySelectorAll('[data-rmlink]').forEach(b => {
      const c = conns[+b.dataset.rmlink];
      b.onclick = () => { if (c) removeBeltLinks(c.ids, ev); closeP(); };
      // pointing at (or tabbing to) a key lights the tiles only its belt rides — the floor answers "which one is that?" (drawHover)
      const lit = on => { if (!c) return; g.classList.toggle('is-peek', !!on); if (!on) { beltCardHot = null; return; } const lt = linkTiles(c.ids); beltCardHot = { cells: (lt.alone.length ? lt.alone : lt.tiles).map(q => ({ x: q.x, y: q.y })), ver: geoVer }; };
      b.addEventListener('pointerenter', () => lit(true)); b.addEventListener('pointerleave', () => lit(false));
      b.addEventListener('focus', () => lit(true)); b.addEventListener('blur', () => lit(false));
    });
    g.querySelector('#belt-ok').onclick = () => { sfx('click'); closeP(); };
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  // a machine as the floor names it: the agent crewing a BAY, a named line's INBOX, else the machine
  function machineName(id) {
    const p = station.propById(id);
    if (!p) return 'a removed machine';
    if (p.t === 'bay') return p.label ? String(p.label).toUpperCase() + (p.agentId ? ' · ' + String(agentLabelFor(p.agentId)).toUpperCase() : '') : p.agentId ? String(agentLabelFor(p.agentId)).toUpperCase() : 'AN EMPTY BAY';
    if (p.t === 'intake') return lineWordOf(p);
    if (p.t === 'outbox') return 'THE OUTBOX';
    return 'THE ' + String(propLabel(p.t)).toUpperCase();
  }

  function openJunctionEditor(propId, ev) {
    if (!root) return;
    cardCloseAll();
    const p = station.propById(propId); if (!p || p.t !== 'filter') return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-junction-editor refit-workflow-editor';
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);

    {
      // resolve lanes at the tile the COMPILER attaches this junction to (own tile OR ring — see
      // junctionBeltTile), so a ring-attached filter is configurable, not a dead editor.
      const jt = junctionBeltTile(p);
      const lanes = jt ? junctionOutLanes(jt.x, jt.y) : [];
      const origin = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
      const exits = jt ? loopExitLabels(valPlan, { x: jt.x - origin.tx, y: jt.y - origin.ty }, agentLabelFor) : [];
      const cur = { routes: (p.routes && typeof p.routes === 'object') ? Object.assign({}, p.routes) : {}, def: p.def || null };
      const selOf = tag => (tag === '__def__' ? cur.def : cur.routes[tag]);
      const ROWS = [['code', 'CODE'], ['research', 'RESEARCH'], ['__def__', 'EVERYTHING ELSE']];
      const rowHtml = ROWS.map(([tag, label]) => {
        const btns = lanes.length
          ? lanes.map(d => '<button type="button" class="bb sm lane-btn' + (selOf(tag) === d ? ' sel' : '') + '" data-tag="' + tag + '" data-dir="' + d + '" aria-pressed="' + (selOf(tag) === d) + '">' + esc(exits.find(x => x.dir === d)?.label || d + ' ' + J_ARROW[d]) + '</button>').join('')
          : '<span class="refit-note bad">Connect an outgoing belt first.</span>';
        return '<div class="refit-route-row"><span class="refit-route-lbl">' + label + '</span><div class="workflow-lane-options">' + btns + '</div></div>';
      }).join('');
      g.innerHTML = '<div class="refit-guide-card" role="dialog" aria-modal="true" aria-labelledby="workflow-title">'
        + workflowIntroHTML('FILTER · SORT TASKS', 'Send each kind of task the right way', 'Choose a path for coding tasks, research tasks and everything else. The Filter reads each task and sends it along the matching belt.')
        + '<div class="workflow-body workflow-columns"><div class="workflow-main"><section class="workflow-section"><h4>Choose a destination for each kind</h4>'
        + '<p class="workflow-help">“Everything else” is the fallback. Set it so other tasks have somewhere to go.</p>'
        + '<div class="refit-filter-rows">' + rowHtml + '</div></section></div>'
        + '<aside class="workflow-aside"><section class="workflow-section"><h4>Which tasks get sorted?</h4>'
        + '<p class="workflow-help">Tasks without an assigned agent use these rules. A task already addressed to an agent follows that agent’s path.</p></section>'
        + '<section class="workflow-section"><h4>Need another destination?</h4><p class="workflow-help">Close this panel and drag this Filter onto another Bay (or use BELT) to connect them. Its destination appears here.</p></section></aside></div>'
        + '<div class="workflow-footer"><span>Save routes to apply your choices.</span><button type="button" class="btn-sm" id="j-clear">CLEAR ROUTES</button><button type="button" class="btn-sm" id="j-cancel">CANCEL</button><button type="button" class="btn-sm refit-primary" id="j-ok">▸ SAVE ROUTES</button></div></div>';
      root.appendChild(g);
      g.querySelector('[data-workflow-close]').onclick = closeP;
      requestAnimationFrame(() => g.classList.add('refit-swap'));
      g.querySelectorAll('.lane-btn').forEach(b => b.onclick = () => {
        const tag = b.dataset.tag, dir = b.dataset.dir;
        if (tag === '__def__') cur.def = (cur.def === dir) ? null : dir;
        else if (cur.routes[tag] === dir) delete cur.routes[tag]; else cur.routes[tag] = dir;
        g.querySelectorAll('.lane-btn[data-tag="' + tag + '"]').forEach(x => {
          x.classList.toggle('sel', selOf(tag) === x.dataset.dir);
          x.setAttribute('aria-pressed', String(selOf(tag) === x.dataset.dir));
        });
      });
      g.querySelector('#j-ok').onclick = () => {
        const res = station.configureJunction(propId, { routes: cur.routes, def: cur.def });
        if (res && res.ok) { sfx('click'); flashTip(ev, cur.def ? 'filter routes saved' : 'set a default lane', !!cur.def); if (cur.def) closeP(); }
        else { sfx('bad'); }
      };
      g.querySelector('#j-clear').onclick = () => { station.configureJunction(propId, null); sfx('click'); flashTip(ev, 'filter cleared', true); closeP(); };
    }
    g.querySelector('#j-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  /* ---------- CONNECTOR PORTAL editor: bind this gateway to ONE configured MCP server. The bound connectorId
     is what bayObjects emits for the bay, so the agent in this room gains that server's live tools. The list is
     the live /api/connectors set; a state dot mirrors the panel. Opens on place/click, like the junction editor. */
  function openConnectorEditor(propId, ev) {
    if (!root) return;
    cardCloseAll();
    const p = station.propById(propId); if (!p || p.t !== 'connector_portal') return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-connector-editor';
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    g.innerHTML = '<div class="refit-guide-card"><h3>▮ CONNECTOR PORTAL — bind an MCP server</h3>'
      + '<ul><li>This gateway grants its bay\'s agent the <b>live tools</b> of ONE configured connector.</li>'
      + '<li>Bind it below — the portal then rides that server\'s state and pulses when its tools fire.</li></ul>'
      + '<div class="refit-conn-rows" id="c-rows">loading…</div>'
      + '<div class="refit-actions"><button type="button" class="btn-sm" id="c-unbind">✕ UNBIND</button><button type="button" class="btn-sm" id="c-cancel">CANCEL</button></div></div>';
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const rowsEl = g.querySelector('#c-rows');
    // semantic state → dot class (theme vars, no inline hex): up=ok · warming/offline=warn · error=bad
    const STATE_CLASS = { connected: 'ok', ready: 'ok', up: 'ok', cached: 'warn', warming: 'warn', offline: 'warn', down: 'warn', error: 'bad' };
    const bind = (id, label) => { const res = station.bindConnector(propId, id); if (res && res.ok) { sfx('click'); flashTip(ev, 'bound → ' + (label || id), true); closeP(); } else sfx('bad'); };
    g.querySelector('#c-unbind').onclick = () => { station.bindConnector(propId, ''); sfx('click'); flashTip(ev, 'portal unbound', true); closeP(); };
    g.querySelector('#c-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    if (typeof fetch === 'undefined') { rowsEl.innerHTML = '<div class="refit-conn-note">no sidecar — can\'t list connectors here.</div>'; return; }
    fetch('/api/connectors').then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => {
      const list = (j && j.connectors) || [];
      if (!list.length) { rowsEl.innerHTML = '<div class="refit-conn-note">No connected services yet — add one first in <b>BUILD › CONNECT › ABILITIES</b> (DISCOVER for the catalog, or ADD AN ABILITY › custom connection), then come back and bind it here.</div>'; return; }
      rowsEl.innerHTML = list.map(c => {
        const sel = (c.id === p.connectorId), scls = STATE_CLASS[c.state] || '';
        const meta = c.toolCount ? (c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's')) : (c.state || 'idle');
        return '<button type="button" class="bb sm conn-row' + (sel ? ' active' : '') + '" data-id="' + esc(c.id) + '" data-label="' + esc(c.label || c.id) + '">'
          + '<span class="conn-dot' + (scls ? ' ' + scls : '') + '">●</span> ' + esc(c.label || c.id)
          + ' <span class="conn-meta">' + esc(meta) + '</span></button>';
      }).join('');
      rowsEl.querySelectorAll('.conn-row').forEach(b => b.onclick = () => bind(b.dataset.id, b.dataset.label));
    }).catch(() => { rowsEl.innerHTML = '<div class="refit-conn-note">sidecar offline — start it to bind a connector.</div>'; });
  }

  /* PLUGIN TERMINAL binder — the connector portal's card, for plugins: which approved plugin this terminal IS. The list
     is the sidecar's own (/api/plugins): only a plugin that is ON can be bound, and each row says what it brings. */
  function openPluginBinder(propId, ev) {
    if (!root) return;
    cardCloseAll();
    const p = station.propById(propId); if (!p || p.t !== 'plugin_terminal') return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-connector-editor';
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    g.innerHTML = '<div class="refit-guide-card"><h3>▮ PLUGIN TERMINAL — choose its plugin</h3>'
      + '<ul><li>This terminal gives its room’s agent the chosen plugin’s <b>tools</b> (each call asks you first, unless you choose Always or Full access).</li>'
      + '<li>Clicking it in the station opens that plugin’s window.</li></ul>'
      + '<div class="refit-conn-rows" id="pl-rows">loading…</div>'
      + '<div class="refit-actions"><button type="button" class="btn-sm" id="pl-unbind">✕ UNBIND</button><button type="button" class="btn-sm" id="pl-cancel">CANCEL</button></div></div>';
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));
    const rowsEl = g.querySelector('#pl-rows');
    const bind = (id, label) => { const res = station.bindPlugin(propId, id); if (res && res.ok) { sfx('click'); flashTip(ev, 'bound → ' + (label || id), true); closeP(); } else sfx('bad'); };
    g.querySelector('#pl-unbind').onclick = () => { station.bindPlugin(propId, ''); sfx('click'); flashTip(ev, 'terminal unbound', true); closeP(); };
    g.querySelector('#pl-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    if (typeof fetch === 'undefined') { rowsEl.innerHTML = '<div class="refit-conn-note">no sidecar — can’t list plugins here.</div>'; return; }
    fetch('/api/plugins').then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => {
      const all = (j && j.plugins) || [];
      const list = all.filter(x => x.active);
      const boundOff = p.pluginId ? all.find(x => x.id === p.pluginId && !x.active) : null;
      const offNote = boundOff ? '<div class="refit-conn-note">Bound to <b>' + esc(boundOff.name || boundOff.id) + '</b>, which is off' + (boundOff.pending ? ' (changed since you approved it)' : '') + ' — turn it on in ⇄ ABILITIES → EXTENSIONS.</div>'
        : (p.pluginId && !all.some(x => x.id === p.pluginId) ? '<div class="refit-conn-note">Bound to <b>' + esc(p.pluginId) + '</b>, which was removed.</div>' : '');
      if (!list.length) { rowsEl.innerHTML = offNote + '<div class="refit-conn-note">No plugins are on yet — create or approve one in <b>⇄ ABILITIES → EXTENSIONS</b>, then bind it here.</div>'; return; }
      rowsEl.innerHTML = list.map(x => {
        const sel = (x.id === p.pluginId);
        const tools = Array.isArray(x.tools) ? x.tools.length : 0, wins = Array.isArray(x.screens) ? x.screens.length : 0;
        const meta = [tools ? tools + ' tool' + (tools === 1 ? '' : 's') : '', wins ? wins + ' window' + (wins === 1 ? '' : 's') : ''].filter(Boolean).join(' · ') || 'hooks only';
        return '<button type="button" class="bb sm conn-row' + (sel ? ' active' : '') + '" data-id="' + esc(x.id) + '" data-label="' + esc(x.name || x.id) + '">'
          + '<span class="conn-dot ok">●</span> ' + esc(x.name || x.id) + ' <span class="conn-meta">' + esc(meta) + '</span></button>';
      }).join('');
      if (offNote) rowsEl.insertAdjacentHTML('afterbegin', offNote);
      rowsEl.querySelectorAll('.conn-row').forEach(b => b.onclick = () => bind(b.dataset.id, b.dataset.label));
    }).catch(() => { rowsEl.innerHTML = '<div class="refit-conn-note">sidecar offline — start it to bind a plugin.</div>'; });
  }

  /* ---------- test run (Polish B): send work down your belts with NO bot connected, and watch it sort to the
     bays right here in BUILD MODE — the build-time payoff + the first thing a tutorial points at.
     THE NARRATED RIDE (2026-07-05): ▸ PREVIEW now teaches the whole two-trip model as it happens — numbered
     captions land at each stage (① enters → ② sorted → ③ delivered to the dock → ④ result ships from the
     dock → ⑤ out), and a delivered test crate spawns a RETURN product crate so the outbound leg shows too.
     Ephemeral, BUILD MODE-preview only, driven by the same engine decisions real work rides on. ---------- */
  const testNotes = [];   // {x, y, text, col, t0} — stage captions over the ride (WORLD tiles)
  const NOTE_MS = 3200;
  function note(x, y, text, col) { testNotes.push({ x, y, text, col: col || '#9adcb0', t0: (typeof performance !== 'undefined') ? performance.now() : 0 }); if (testNotes.length > 12) testNotes.shift(); }
  const agentLabelFor = aid => {
    const list = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const a = list.find(x => x.id === aid);
    return ((a && a.name) || aid || 'AGENT').toUpperCase();
  };
  // world-frame stops map for the preview sim: bound-bay hookup tiles (LOCAL plan keys rebased by origin).
  // DOCK-KEYED (2026-09-27 audit X2): every stop names its DOCK as well as its agent, so a preview hand-off is
  // consumed at the NEXT dock and never at the dock that produced it — the same rule the live floor rides
  // (conveyor.js: a stop object {agentId, dockId} + payload.fromDockId). Memoized per compiled plan + origin:
  // the frame loop asks for it every tick.
  let stopsMemo = null, stopsPlan = null, stopsOx = 0, stopsOy = 0;
  function testStops() {
    if (!valPlan || !valPlan.bayTileToAgent || !cacheGeo) return null;
    const o = cacheGeo.origin || { tx: 0, ty: 0 };
    if (stopsMemo && stopsPlan === valPlan && stopsOx === o.tx && stopsOy === o.ty) return stopsMemo;
    const out = {}, docks = valPlan.bayTileToDock || {};
    for (const k in valPlan.bayTileToAgent) {
      const p = k.split(','), wk = (+p[0] + o.tx) + ',' + (+p[1] + o.ty), a = valPlan.bayTileToAgent[k];
      out[wk] = docks[k] ? { agentId: a, dockId: docks[k] } : a;
    }
    stopsMemo = out; stopsPlan = valPlan; stopsOx = o.tx; stopsOy = o.ty;
    return out;
  }
  const stopAgent = s => (s && typeof s === 'object') ? s.agentId : (s || null);
  const stopDock = s => (s && typeof s === 'object') ? (s.dockId || null) : null;
  const planOrigin = () => (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
  const localKeyOf = (x, y) => { const o = planOrigin(); return (x - o.tx) + ',' + (y - o.ty); };
  // the tile a dock SHIPS its result from (the compiled ship hookup — the same tile the sidecar spawns the real
  // hand-off crate on), in WORLD tiles; null for a dock with no belt out
  function shipTileOf(dockId) {
    const r = dockId && valPlan && valPlan.dockChains && valPlan.dockChains[dockId];
    if (!r || !r.tile) return null;
    const o = planOrigin();
    return { x: r.tile.x + o.tx, y: r.tile.y + o.ty };
  }
  const isOutboxMouth = (x, y) => { const k = localKeyOf(x, y); return ((valPlan && valPlan.outs) || []).some(o => o.tile && (o.tile.x + ',' + o.tile.y) === k); };
  const junctionCfgAt = (x, y) => (valPlan && valPlan.junctions && valPlan.junctions[localKeyOf(x, y)]) || null;
  const PREVIEW_MAX_HOPS = 8;   // a preview crate stops narrating after this many docks (a loop can't spin it forever)
  const previewJoins = {};      // family -> copies that reached their JOINER (the preview's own barrier)
  /* THE NARRATED RIDE follows the REAL line (2026-09-27 audit X2). The product crate used to be born on the tile
     where the job ARRIVED (the dock's input side) and flagged outbound, so it fell off the belt into the dock's
     own footprint and the preview announced "…AND OUT. THAT IS THE WHOLE LOOP" after step one of every
     multi-step line. Now: a dock that gets a job works it, and its result is born on the dock's compiled SHIP
     tile as a hand-off crate, so it rides on to the next dock (and the next), through splitters, joiners and
     loop gates, until it reaches the OUTBOX or the belt ends. Every caption says what the engine just did. */
  function onBuildDeliver(bx, x, y) {
    pushFlash([{ x1: x, y1: y, x2: x, y2: y }], false); sfx('click');
    const p = bx.payload || {};
    if (!p.test) return;
    const st = (testStops() || {})[x + ',' + y];
    const owner = stopAgent(st), dock = stopDock(st);
    // a result riding off the belt END beside its OWN dock (the ship tile is often also the OUTBOX mouth) is a ship-out, never a
    // hand-off to itself — conveyor.js calls onDeliver at an open end without asking whose hookup the tile is
    const own = !!(p.product && owner && ((dock && p.fromDockId) ? p.fromDockId === dock : p.fromAgentId === owner));
    if (owner && !p.outbound && !own) {
      const hops = (p.hops | 0) + 1;
      note(x, y, p.product ? (p.joined ? 'COMBINED RESULT → ' : 'HANDED TO ') + agentLabelFor(owner) : agentLabelFor(owner) + ' WORKS IT', '#e8c860');
      if (hops >= PREVIEW_MAX_HOPS) { setTimeout(() => note(x, y + 1, '…PREVIEW STOPS HERE', '#9adcb0'), 900); return; }
      const ship = shipTileOf(dock);
      if (!ship) { setTimeout(() => note(x, y + 1, 'NO BELT OUT — RESULT GOES BACK', '#ffbe3c'), 900); return; }
      setTimeout(() => {
        if (!running || !convey) return;
        convey.enqueueAt(ship.x, ship.y, { test: true, product: true, box: 'product', fromAgentId: owner, fromDockId: dock || undefined,
          hops, iteration: p.iteration | 0, family: p.family, familySize: p.familySize, workitemId: 'test-out-' + (++_testN) });
        note(ship.x, ship.y, 'RESULT GOES ON…', '#9adcb0');
      }, 900);
      return;
    }
    if (owner && !own) return;   // a legacy outbound crate reaching a dock tile: nothing to narrate
    if (p.product || p.outbound) {
      const out = isOutboxMouth(x, y);
      note(x, y, out ? '✓ OUT AT THE OUTBOX' : 'BELT ENDS — NO OUTBOX', out ? '#7ee2a8' : '#ffbe3c');
    } else {
      note(x, y, 'SANK — NO AGENT HERE YET', '#ffbe3c');
    }
  }
  // junction watcher: caption each decision the moment the engine makes it (the same onAdvance seam the telemetry
  // uses — a caption can only ever say what the engine actually did), plus the two behaviours the belt sim does
  // not perform by itself and the sidecar does: a fan-out SPLIT sends every branch a copy, and a JOINER waits for
  // every copy before ONE combined result goes on.
  function onBuildAdvance(bx, info) {
    if (!bx.payload || !bx.payload.test || !info || !info.tile) return;
    const { x, y } = info.tile, cfg = junctionCfgAt(x, y) || {};
    if (info.kind === 'filter') note(x, y, 'SORTED: ' + String(info.tag || 'general').toUpperCase() + ' → THIS BELT', '#5ad0ff');
    else if (info.kind === 'split') {
      if ((info.fanout || cfg.fanout) && typeof Pipeline !== 'undefined' && Pipeline._internals && station) {
        const map = {};
        for (const b of station.belts()) map[b.x + ',' + b.y] = b.dir;
        const lanes = Pipeline._internals.outLanes(map, x, y) || [];
        const V = Pipeline._internals.DIRV || {};
        const fam = bx.payload.family || ('fam-' + (++_testN));
        bx.payload.family = fam; bx.payload.familySize = Math.max(lanes.length, 1);
        for (const d of lanes) {
          if (d === info.lane || !V[d]) continue;
          convey.enqueueAt(x + V[d][0], y + V[d][1], Object.assign({}, bx.payload, { workitemId: 'test-copy-' + (++_testN) }));
        }
        note(x, y, cfg.divide ? 'SPLIT: EACH BRANCH GETS ITS PART' : 'SPLIT: A COPY TO EACH BRANCH', '#5ad0ff');
      } else note(x, y, 'SPLIT: BRANCHES TAKE TURNS', '#5ad0ff');
    }
    else if (info.kind === 'join') {
      const fam = bx.payload.family, need = bx.payload.familySize | 0;
      if (fam && need > 1) {
        const got = previewJoins[fam] = (previewJoins[fam] || 0) + 1;
        if (got < need) { convey.dropWorkitem(bx.payload.workitemId); note(x, y, 'JOINER: ' + got + ' OF ' + need + ' IN — WAITING', '#5ad0ff'); }
        else { delete previewJoins[fam]; bx.payload.family = undefined; bx.payload.familySize = undefined; bx.payload.joined = true; note(x, y, 'JOINER: ALL ' + need + ' IN → ONE RESULT', '#5ad0ff'); }
      } else note(x, y, 'JOINER: PASSES IT ON', '#5ad0ff');
    }
    else if (info.kind === 'loop') {
      if (cfg.back && info.lane === cfg.back) {
        // one revision round is enough to show the gate; the real gate follows the reviewer's VERDICT line
        bx.payload.iteration = 99;
        note(x, y, 'LOOP: BACK FOR A REWRITE', '#5ad0ff');
      } else if (info.escalated) note(x, y, 'LOOP: OUT OF PASSES → FIXER', '#ffbe3c');
      else note(x, y, 'LOOP: APPROVED → ON', '#7ee2a8');
    }
    else if (info.kind === 'merge') note(x, y, 'MERGER: ONE SHARED BELT', '#5ad0ff');
  }
  // the INTAKE's belt-adjacent tile (where a box spawns), or null if no INTAKE sits on a belt.
  // DOC-ORDER FIRST INTAKE — kept ONLY as the manual ▸ PREVIEW's last-resort fallback when no
  // compiled lane reaches a bound dock yet (the "③ SANK" caption is the honest teaching there).
  function intakeBeltTile() {
    const intake = station.props().find(p => p.t === 'intake');
    if (!intake) return null;
    const w = intake.w || 1, h = intake.h || 1;
    for (let yy = intake.y - 1; yy <= intake.y + h; yy++)
      for (let xx = intake.x - 1; xx <= intake.x + w; xx++)
        if (station.beltAt(xx, yy)) return { x: xx, y: yy };
    return null;
  }
  /* the ride's SPAWN mouth, WORLD tiles — reach-aware (conveyor-audit 2026-08-10). The first
     intake in doc order can be a decorative/unfinished one on a DIFFERENT line; a ride that
     enters there sinks with "③ SANK" at the exact teachable moment. So the ride enters through
     a door that provably leads somewhere, read from the SAME compiled plan the sidecar routes by
     (mirror of ghostline's spawn rule + world.js's addressed-crate physics):
       • agentId given (the line under test — the first ride names the dock whose reach flipped) →
         Pipeline.sourceFor: the mouth whose lane actually REACHES that dock, or null (no guess);
       • lineless (the toolbar ▸ PREVIEW) → the first source in PLAN order with a reaching mouth.
     Plan mouths are LOCAL-frame (valPlan compiles from cacheGeo) → rebase by the geo origin,
     the same rebase testStops() rides. */
  function rideMouthFor(agentId) {
    if (!valPlan || !valPlan.sources || !valPlan.sources.length || !cacheGeo) return null;
    if (typeof Pipeline === 'undefined' || !Pipeline.sourceFor) return null;
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, rb = t => ({ x: t.x + o.tx, y: t.y + o.ty });
    if (agentId) { const t = Pipeline.sourceFor(valPlan, agentId); return t ? rb(t) : null; }
    // lineless: every reaching dock names its own front door; the earliest such mouth in plan
    // order wins (deterministic — plan order + ring-scan order are both fixed, like resolveTarget)
    const mouths = [];
    for (const a in (valPlan.reach || {})) {
      if (!valPlan.reach[a]) continue;
      const t = Pipeline.sourceFor(valPlan, a);
      if (t) mouths.push(t);
    }
    if (!mouths.length) return null;
    for (const s of valPlan.sources) {
      const ts = (s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []);
      for (const mt of ts) if (mouths.some(m => m.x === mt.x && m.y === mt.y)) return rb(mt);
    }
    return rb(mouths[0]);
  }
  let _testN = 0;
  // fire one box per content tag at the INTAKE so you watch them SORT through your FILTERs to the right
  // bays. Returns true only when boxes actually rode — the auto first ride burns its one-shot on that.
  /* ONE TEST CONTROL (2026-09-28 — "replace the four test buttons with one TEST control that has modes"). The top bar's TEST
     opens the Workflow panel's TEST view on the line — the one the panel already shows, else the first line with an INBOX
     and a BAY — and plays the free walkthrough straight away, so the old one-click preview stays one click and the real
     modes sit right beside it. No line yet: the walkthrough alone, which says what is missing. */
  function openTest(e) {
    const WP = typeof WorkflowPanel !== 'undefined' ? WorkflowPanel : null;
    if (WP && WP.showTest) {
      try {
        if (!(WP.isOpen && WP.isOpen())) {
          const c = (valComps || []).find(x => x.intakes.length && x.bays.length) || (valComps || [])[0];
          const pid = c ? (c.intakes[0] || (c.bays[0] && c.bays[0].propId)) : null;
          if (pid) openFlowCard(pid);
        }
        WP.showTest('watch');
      } catch (err) { /* the walkthrough below still runs */ }
    }
    return sendTestBoxes(e);
  }
  // a floor tile's centre in client px (the same mapping the dev hooks' _tileEvent uses) — where a tip about that tile is said
  const tileClient = (tx, ty) => { const t = T(), r = cv.getBoundingClientRect(); return { clientX: r.left + ((tx + 0.5) * t * zoom + panX) * (r.width / cv.width), clientY: r.top + ((ty + 0.5) * t * zoom + panY) * (r.height / cv.height) }; };
  function sendTestBoxes(ev, auto, agentId) {
    if (!convey) return false;
    // reach-verified mouth first; the doc-order intake only for a MANUAL test on a floor where
    // nothing reaches yet. The AUTO ride never takes the fallback: it only ever fires because a
    // line powered on, and a decorative intake would spend the one narration on a sink.
    const t = rideMouthFor(agentId) || (auto ? null : intakeBeltTile());
    if (!t) { if (!auto) { flashTip(ev, 'place an INBOX on a belt first', false); sfx('bad'); } return false; }
    // ONE crate tells a plain line's story; three (one per task type) only when a FILTER is there to sort them —
    // three narrations of the same unsorted line just stacked their captions on top of each other (2026-09-27 audit X2)
    const sorts = !!(valPlan && valPlan.junctions && Object.keys(valPlan.junctions).some(k => valPlan.junctions[k] && valPlan.junctions[k].kind === 'filter'));
    for (const tag of (sorts ? ['code', 'research', 'general'] : ['general'])) convey.enqueueAt(t.x, t.y, { workitemId: 'test-' + (++_testN), tag, preview: 'test ' + tag, test: true });
    note(t.x, t.y, '① WORK COMES IN HERE', '#e8c860');
    // the auto ride's word is said by the line's own door on the floor — never at the last pointer spot (that was over the panel)
    const at = auto ? tileClient(t.x, t.y) : ev;
    flashTip(at, auto ? 'LINE READY — a test crate rides it now (free: no agent runs). ' + PREVIEW_LABEL + ' › WATCH IT replays it' : 'test work riding — watch the loop', true);
    sfx('click');
    return true;
  }

  /* ---------- THE FIRST CRATE NARRATES ITSELF (2026-08-04 onramp) ----------
     The first time this station's floor compiles COMPLETE in BUILD MODE — an INTAKE lane actually
     reaching a BOUND bay (valPlan.reach), which is the moment liveTiles first energize a full
     route — the narrated ▸ PREVIEW ride auto-runs once, unprompted. That is exactly the teachable
     moment: the user just bound the agent that powered the line on. Once per station, persisted
     in localStorage keyed by the station doc's createdAt (doc.meta is whitelisted-fields
     territory in migrate() — a save-schema field for a UI one-shot is the wrong tool; localStorage
     mirrors the SEEN_KEY idiom above and survives reloads the same way).
     LAW (tutorial-audit 2026-08-03): anything coach-like stands down while the tutorial is
     coaching — gate on Tutorial.isCoaching() and the `.refit-firstrun` card, NEVER `.refit-guide`
     (the bay/flow/junction editors share that class; suppressing on it would kill the ride the
     moment the bay picker that caused it closed). Gated attempts stay ARMED (ridePending) and
     fire from the frame loop once the coach clears — a deferred ride must not need another edit
     to re-trigger. A blueprint stamp alone can never fire this: its bays stamp unbound, so reach
     stays false until an agent is truly bound. */
  // one per-station localStorage key root, shared by the first-ride flag and the finish-the-line
  // registry (same doc.meta.createdAt derivation — a UI one-shot never rides the save schema).
  /* THE STATION'S OWN NAMESPACE. Every one-shot below (first ride, ORDERS dismissal, the finish-the-line
     registry) is per-STATION, so it must hang off a durable per-station id — `doc.meta.createdAt`, stamped
     once at creation and backfilled once on migrate (worldmodel.js stationId). Before 2026-08-07 nothing
     ever stamped it, so this always answered 'default' and every "per-station" latch was in fact global:
     a brand-new station inherited the first one's dismissals, never saw its first ride, and had its first
     line retired before the card was ever shown. 'default' survives only as the storage-broken fallback. */
  function stationKeyOf(st) {
    let k = 'default';
    try { const d = st && st.doc && st.doc(); if (d && d.meta && d.meta.createdAt) k = String(d.meta.createdAt); } catch (e) {}
    return k;
  }
  const RIDE_KEY = () => 'starnet.refit.firstride.' + stationKeyOf(station);
  function rideSeen() { try { return !!localStorage.getItem(RIDE_KEY()); } catch (e) { return true; } }   // broken storage → never risk a repeat
  function markRide() { try { localStorage.setItem(RIDE_KEY(), '1'); } catch (e) {} }
  let ridePending = false, rideTimer = 0, rideAgentId = null, ridePrevReach = null;
  function maybeFirstRide() {
    /* THE RIDE NAMES ITS LINE (conveyor-audit 2026-08-10). "Complete" used to be any reach=true
       plus any doc-order intake — on a floor with an older decorative intake, the one narrated
       ride entered the WRONG line and sank. Now the arm records WHICH dock powered on (prefer
       the reach that flipped true THIS compile — that bind is the teachable moment), and
       fireFirstRide rides THAT dock's own front door via rideMouthFor. */
    const prev = ridePrevReach || {}, now = {}, entry = !ridePrevReach;
    // a line counts once it is COMPLETE: its dock reached by an intake lane AND every step of it crewed (2026-09-30: it
    // announced LINE COMPLETE over the panel while the WRITER had none) — so binding a line's last agent completes it too
    const crewed = a => (valComps || []).some(c => c.intakes.length && c.bays.some(b => b.agentId === a) && c.bays.every(b => b.agentId));
    if (valPlan && valPlan.reach) for (const a in valPlan.reach) if (valPlan.reach[a] && crewed(a)) now[a] = true;
    ridePrevReach = now;
    /* A RIDE ONLY ANSWERS THE EDIT THAT POWERED ITS LINE (2026-10-14, the busy-station walk: one lone INBOX placed, and the
       floor said "LINE READY — a test crate rides it now" over the foreman's untouched line across the station). The
       session's first compile only takes the baseline: a line that was already complete when BUILD MODE opened is nobody's
       edit, and a ride armed for it played over the floor as the editor opened (or, held back by a card, after the user's
       first unrelated edit). Its one shot is not burned — the ride arms on the first line a compile completes after an edit,
       and stays armed until it narrates. */
    if (entry || ridePending || rideSeen()) return;
    let rideA = null;
    for (const a in now) if (!prev[a]) { rideA = a; break; }   // the line this compile completed
    if (!rideA || !rideMouthFor(rideA)) return;   // complete = an intake lane reaches a bound bay, entered through ITS OWN mouth
    rideAgentId = rideA;
    ridePending = true;   // armed — frame() fires it once nothing coach-like is up
  }
  function fireFirstRide() {
    ridePending = false;
    // a beat after the bind flash so the two tips don't stomp each other mid-read. The flag is
    // consumed ONLY WHEN THE RIDE ACTUALLY NARRATES — sendTestBoxes returning true on the reaching
    // line's own mouth. Closing BUILD MODE inside the beat, or a floor edit that dissolves the line
    // under it, keeps the one shot (the next compile re-arms via maybeFirstRide).
    rideTimer = setTimeout(() => { rideTimer = 0; if (running && convey && sendTestBoxes(null, true, rideAgentId)) markRide(); }, 700);
  }
  // render the stage captions: a plate over the tile each speaks about, a brief rise, world coords (drawn after the boxes)
  function drawTestNotes(now, t) {
    if (!testNotes.length) return;
    // ride captions register on the activeFlow layer (a running ▸ PREVIEW is a live gesture — it
    // outranks hover/nags, and the arbiter keeps overlapping captions from garbling each other)
    for (let i = testNotes.length - 1; i >= 0; i--) {
      const n = testNotes[i], k = (now - n.t0) / NOTE_MS;
      if (k >= 1) { testNotes.splice(i, 1); continue; }
      const rise = Math.min(1, k * 4) * 6 / zoom;
      const box = captionBox(n.text, (n.x + 0.5) * t, n.y * t - 5 / zoom - rise);
      // fully lit while it is read: in fast, out over the last quarter (it used to fade from the moment it appeared)
      const alpha = k < 0.12 ? k / 0.12 : k > 0.75 ? (1 - k) / 0.25 : 1;
      voiceSay('activeFlow', { x: n.x * t, y: n.y * t, w: t, h: t }, box, c => captionPlate(c, n.text, box, n.col, alpha));
    }
  }
  /* A FLOOR CAPTION IS A PLATE (2026-09-30 — "the system viewer … should look better"). The ride's captions and the paused
     hand-off's label were bare phosphor text with a glow, laid straight over machines and belts and running on under the
     docked panel. They wear the gesture badge's plate now (ghostBadge: a dark field, a hairline in the caption's own colour,
     plain text, no glow), and a plate is kept on the visible glass.
     A caption is set at the panel's own reading size ON SCREEN (17px, times the display's pixel ratio and the TEXT SIZE
     zoom), whatever the camera zoom: the shared label size is 9 WORLD px, which at a working zoom printed captions twice
     that tall — a plate that size covers the machines it is talking about.
     captionBox answers the plate's rect in world px, centred on cx with its bottom edge at bottomY (or its top at topY).
     captionFit slides any caption rect sideways onto the glass. */
  const capFs = () => 17 * (dpr || 1) * ((typeof U !== 'undefined' && U.uiZoom && U.uiZoom()) || 1) / zoom;
  const CAP_FONT = () => capFs() + "px 'VT323','Courier New',monospace";
  function captionFit(box) {
    const ins = viewInsetsFrame(), m = 4 / zoom;
    const left = (ins.l - panX) / zoom + m, right = (cv.width - (ins.r || 0) - panX) / zoom - m;
    box.x = clamp(box.x, left, Math.max(left, right - box.w));
    return box;
  }
  function captionBox(text, cx, bottomY, topY) {
    const fs = capFs(), padX = fs * 0.5, padY = fs * 0.2;
    ctx.save(); ctx.font = CAP_FONT();
    const w = ctx.measureText(text).width + padX * 2, h = fs + padY * 2;
    ctx.restore();
    return captionFit({ x: cx - w / 2, y: topY != null ? topY : bottomY - h, w, h, fs });
  }
  function captionPlate(c, text, box, col, alpha) {
    c.save();
    c.globalAlpha = alpha == null ? 1 : alpha;
    c.fillStyle = 'rgba(4,6,8,0.86)'; c.fillRect(box.x, box.y, box.w, box.h);
    c.strokeStyle = col; c.lineWidth = 1 / zoom;
    c.strokeRect(box.x + 0.5 / zoom, box.y + 0.5 / zoom, box.w - 1 / zoom, box.h - 1 / zoom);
    c.font = CAP_FONT(); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = col;
    c.fillText(text, box.x + box.w / 2, box.y + box.h / 2 + box.fs * 0.06);
    c.restore();
  }

  /* ---------- FINISH THE LINE (guided workflows Phase 2, 2026-08-05) ----------
     A compact checklist card anchored beside a stamped/incomplete line, derived ONLY from provable
     state: the COMPILED plan (crew count = its UNBOUND_BAY warns over this line's docks), the
     server-proven feed truth (World.feedState — the exact NO FEED source), and the sample-job seam
     (feature-detected, below). LAWS: never blocks editing (a floating side card, no backdrop),
     dismissible, stands down while the tutorial coaches (Tutorial.isCoaching / .refit-firstrun —
     same gate as the first ride), and stands down per line once that line has SHIPPED (its FIRST SHIP:
     the sidecar's shipment record — noteLineShipped / markLineShipped, never a crate sinking at a chute,
     which a direct COMMS order rides too) AND nothing is left to do: a shipped line nothing starts keeps
     its card, ② in view, until a real start or a SEND TO into it exists (2026-10-12).
     Line identity + membership come from Pipeline.lineComponents (key = smallest member prop id,
     stable in the save); shipped/dismissal persist in localStorage beside the first-ride flag. */
  const FIN_KEY = st => 'starnet.refit.finline.' + stationKeyOf(st || station);
  /* UPGRADE, ONCE PER STATION (2026-10-12): older builds marked a line `done` when a product crate sank at its chute, and the old
     FIRST SHIP and the card's retirement both answered to it. A line an older build already delivered on has had its moment, so
     its `done` is read once as `shipped` — FIRST SHIP spent, never a second gold toast after the upgrade. The marker keeps a `done`
     written later from ever being honoured (nothing here writes one any more: a crate proves no shipment). */
  const FIN_MIG = st => 'starnet.refit.finline.v2.' + stationKeyOf(st || station);
  const finMigrated = new Set();
  function finRead(st) {
    let o;
    try { o = JSON.parse(localStorage.getItem(FIN_KEY(st)) || '{}'); } catch (e) { return {}; }
    if (!o || typeof o !== 'object') o = {};
    const mk = FIN_MIG(st);
    if (!finMigrated.has(mk)) {
      finMigrated.add(mk);
      try {
        if (!localStorage.getItem(mk)) {
          let moved = false;
          for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object' && o[k].done && !o[k].shipped) { o[k].shipped = 1; moved = true; }
          if (moved) localStorage.setItem(FIN_KEY(st), JSON.stringify(o));
          localStorage.setItem(mk, '1');
        }
      } catch (e) { finMigrated.delete(mk); }   // (storage refused: try again on the next read, never half-migrate)
    }
    return o;
  }
  function finMark(st, key, field) {
    try {
      const o = finRead(st);
      o[key] = Object.assign({}, o[key]); o[key][field] = 1;
      localStorage.setItem(FIN_KEY(st), JSON.stringify(o));
    } catch (e) {}
  }
  /* SAMPLE-JOB seam detection (Phase 4 lands in parallel — never hardcode its presence): the card
     asks `GET /api/routing/sample` once per BUILD MODE session. Present = any real answer that isn't a
     route-miss (404/405); absent = the router's static 404. An OPTIONS probe is useless here — the
     sidecar 204s OPTIONS on EVERY /api/* path before dispatch (index.js preflight branch). A POST
     probe is forbidden: when the seam exists a POST IS the paid sample dispatch. Fails SAFE: on any
     doubt the button renders disabled ("coming online soon") and no request can spend anything. */
  let finSample = null;   // null = unprobed/in flight · false = absent · true = present
  const finApi = p => ((typeof window !== 'undefined' && window.__STARNET_API__) ? window.__STARNET_API__ : '') + p;
  function probeSampleSeam() {
    if (finSample !== null || typeof fetch === 'undefined') return;
    try {
      fetch(finApi('/api/routing/sample'))
        .then(r => { finSample = !!(r && r.status !== 404 && r.status !== 405); renderFinCard(); })
        .catch(() => { finSample = false; renderFinCard(); });
    } catch (e) { finSample = false; }
  }
  let valComps = null;          // Pipeline.lineComponents of the CURRENT compiled geometry (set in rebake)
  let lastStampIds = null;      // prop ids of the line stamped this session → the card adopts that line
  const stampNameOf = {};       // intake propId -> blueprint label (session-scoped; the name field's placeholder)
  let finKeySel = null;         // the line key the card is focused on (session-scoped)
  let finEngaged = false;       // workflow guidance follows an explicit configuration action
  let finCardEl = null, finComp = null, finSig = '', finPollTs = 0;
  let finStartsMemo = null;   // { plan, facts, geo, crew, by: { lineKey: anyStart } } — lineStartsHere, re-read only when one of those moves
  function finState(c) {
    const unbound = c.bays.filter(b => !b.agentId);
    const feed = (opts && opts.world && opts.world.feedState) ? opts.world.feedState() : { known: false, fed: false };
    const hasIntake = c.intakes.length > 0;
    const fedLines = opts && opts.world && opts.world.fedLines ? opts.world.fedLines(valPlan) : Pipeline.fedLineIds(valPlan);
    /* ② is done on evidence about THIS line (wave 2 repair, build-12): a start the server reports for it — a routine that runs it from
       its entry step, a connected channel answering as its first step, an armed trigger of its own (lineStartsHere: the Workflow
       panel's own reader) — or a hand-off from a line that can run / work that really arrived (fedLines). The station-wide `fed`
       (ANY channel / routine / trigger anywhere) said AUTOMATIC START CONFIGURED for a line nothing starts. */
    const autoStart = hasIntake && feed.known && lineStartsHere(c);
    const feedDone = hasIntake && (autoStart || !!fedLines[c.key]);
    // a routine IS saved for this line but scheduling is off (2026-09-28 retest): ② says so, and still opens the INBOX section,
    // where the TURN SCHEDULING ON switch is — never "choose what starts this line" over a start the Commander already chose
    let schedOff = false;
    try { schedOff = hasIntake && feed.known && !autoStart && !!(opts && opts.world && opts.world.schedOffFor && opts.world.schedOffFor(c.intakes[0], valPlan)); } catch (_) { schedOff = false; }
    return { unbound, crewLeft: unbound.length, hasIntake, feed, autoStart, feedDone, schedOff,
      todo: unbound.length > 0 || (hasIntake && feed.known && !feedDone) };
  }
  // does the server report a start of THIS line? WorkflowLine.lineStarts over the facts World's feed poll read (the Workflow panel and
  // the lead's station.layout read a line's starts through the same function) — memoized per plan + facts + floor + crew roster
  function lineStartsHere(c) {
    const W = typeof WorkflowLine !== 'undefined' ? WorkflowLine : null;
    const facts = opts && opts.world && opts.world.startFacts ? opts.world.startFacts() : null;
    if (!c || !facts || !valPlan || !W || !W.lineFlow || !W.lineStarts) return false;
    const agents = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const crew = agents.map(a => (a && a.id) + ':' + (a && a.name)).join('|');
    if (!finStartsMemo || finStartsMemo.plan !== valPlan || finStartsMemo.facts !== facts || finStartsMemo.geo !== cacheGeo || finStartsMemo.crew !== crew) finStartsMemo = { plan: valPlan, facts, geo: cacheGeo, crew, by: {} };
    if (!(c.key in finStartsMemo.by)) {
      const flow = W.lineFlow(valPlan, c, Pipeline, (cacheGeo && cacheGeo.props) || []);
      const st = W.lineStarts(flow, { lt: facts.lt, lineKey: c.key, cron: facts.cron, chans: facts.chans, agents });
      finStartsMemo.by[c.key] = !!(st && (st.schedules.length || st.channels.length || st.events.length));
    }
    return finStartsMemo.by[c.key];
  }
  // ② in words, from finState — done only by what STARTS the line: another line's SEND TO into it (named by the one line name; a
  // sender counts only if it can run — Pipeline.lineSenders) or an automatic start of THIS line (lineStartsHere). A run that
  // already came by (a sample, a test) starts nothing, so it never ticks this step (2026-10-12, M7 + build-12)
  function finFeedText(st, senders) {
    if (st.feedDone) return senders && senders.length ? '✓ FED BY ' + senders.join(' + ') : st.autoStart ? '✓ AUTOMATIC START CONFIGURED' : '✓ ANOTHER LINE SENDS IT WORK';
    if (!st.hasIntake) return '② FEED IT — TASK THE AGENT, OR WIRE A ROUTINE';
    if (!st.feed.known) return '② CHECKING WHAT STARTS THIS LINE…';
    return st.schedOff ? '② SCHEDULING IS OFF — TURN IT ON' : '② CHOOSE WHAT STARTS THIS LINE';
  }
  function finPick() {
    if (!valComps || !valComps.length) return null;
    const reg = finRead(station);
    // ✕ quiets a line for good; a line that SHIPPED is done as a guide only once nothing is left to do (a shipped line nothing
    // starts keeps ② CHOOSE WHAT STARTS THIS LINE in view — the floor still says NO FEED there)
    const quiet = c => { const r = reg[c.key]; return !!(r && (r.dis || (r.shipped && !finState(c).todo))); };
    const live = valComps.filter(c => c.bays.length && c.beltCount && !quiet(c));
    if (!live.length) return null;
    const sel = live.find(c => c.key === finKeySel);
    if (sel) return sel;
    // otherwise: the first line with something left to DO. A fully-crewed+fed veteran line that was
    // never stamped this session stays quiet (its remaining step is the sample, offered only in the
    // stamp session) — the card guides work, it doesn't haunt finished floors.
    const next = live.find(c => finState(c).todo) || null;
    if (next) finKeySel = next.key;
    return next;
  }
  /* ---------- STARTER GEAR (2026-08-18, Andrew — replaces STATION ORDERS) ----------
     This slot used to hold STATION ORDERS (grow/dress/desk/line). Andrew's call: the thing a
     beginner must see FIRST is which props actually matter — the starter POWERS — and a shelf
     inside the prop palette was too easy to miss, so the powers checklist takes this card
     instead (same one-voice slot; FINISH THE LINE still takes over the moment a line compiles).

     The list is PropSprites.STARTER (the tutorial kit + studio — capability grants only, no bay:
     that is conveyor equipment, not a necessity). Every row is a live projection of the model:
     done = the POWER is on the floor, by GRANT not by id (a placed VAULT honestly ticks the
     INTEL CAB row — both grant FILES), and clicking a row ARMS the prop tool with that prop
     picked — the checklist is the control, not a description of one. It gates nothing. The card
     retires on its own at 5/5 WITHOUT burning the dismiss key, so reclaiming your only dish
     brings it back; ✕ still dismisses it forever for Commanders who know the drill. */
  // PER STATION, like every other one-shot here (stationKeyOf) — this shipped with no suffix at all, so
  // dismissing the card on one station silently dismissed it on every station the Commander ever builds.
  const ORDERS_KEY = () => 'starnet.refit.orders.dis.' + stationKeyOf(station);
  const ordersDismissed = () => { try { return !!localStorage.getItem(ORDERS_KEY()); } catch (e) { return false; } };
  let ordersSeenDone = null;   // which steps were already done last render (so a NEW completion can chime)

  function ordersSteps() {
    const starter = ((typeof PropSprites !== 'undefined' && PropSprites.STARTER) || [])
      .map(id => (PropSprites.spec ? PropSprites.spec(id) : null)).filter(Boolean);
    const placed = {};
    for (const p of station.props()) { const g = grantLabelOf({ id: p.t }); if (g) placed[g] = 1; }
    return starter.map(c => {
      const g = grantLabelOf(c) || '?';
      return { id: c.id, done: !!placed[g], cat: c.cat, label: g + ' — ' + c.label,
        tip: 'Choose this ability when your work needs it. Props with the ' + g + ' badge are alternatives; inspect the selected prop for scope and current access.' };
    });
  }

  function ordersHide() {
    if (finCardEl && finCardEl.parentNode) finCardEl.parentNode.removeChild(finCardEl);
    finCardEl = null; finComp = null; finSig = '';
  }

  function renderOrders() {
    bumpUi();   // same as renderFinCard: the card in this slot is about to be rebuilt/re-measured
    if (ordersDismissed() || tool === 'prop') return ordersHide();
    const steps = ordersSteps();
    const done = steps.filter(s => s.done).length;
    // a step that flipped to done SINCE the last render earns the cue — never on the first paint,
    // or every reopened session would replay the whole checklist at you. Checked BEFORE the
    // all-done retirement below, so the final power landing still chimes as the card leaves.
    if (ordersSeenDone) { for (const s of steps) if (s.done && !ordersSeenDone[s.id]) { sfx('quest'); break; } }
    ordersSeenDone = {}; for (const s of steps) if (s.done) ordersSeenDone[s.id] = 1;
    // every power is on the floor → the card's claim is answered; retire it (no dismiss key —
    // reclaiming a power re-summons it, because done is read live off the doc, never stored)
    if (steps.length && done === steps.length) return ordersHide();
    const sig = 'orders|' + steps.map(s => (s.done ? 1 : 0)).join('');
    if (!finCardEl) {
      finCardEl = document.createElement('div');
      finCardEl.className = 'refit-finline refit-orders';
      root.appendChild(finCardEl);
    } else if (sig === finSig) return;
    finSig = sig; finComp = null;
    finCardEl.className = 'refit-finline refit-orders';
    finCardEl.innerHTML = '<div class="fl-head"><span class="fl-title">▸ EQUIPMENT BY PURPOSE</span>'
      + '<span class="fl-count">' + done + ' on floor</span>'
      + '<button type="button" class="bb sm fl-x" title="dismiss — you know the gear">✕</button></div>'
      + steps.map((s, i) => '<button type="button" class="bb fl-step' + (s.done ? ' done' : '') + '" data-ord="' + s.id + '"'
        + ' title="' + esc(s.tip) + '">' + (s.done ? '✓ ' : '+ ') + esc(s.label) + '</button>').join('')
      // the release valve (Andrew): five needs, and permission to ignore the other ~137 props
      + '<div class="fl-opt">Choose what your task needs. You can already chat. Matching badges are alternatives, not a checklist.</div>';
    finCardEl.querySelector('.fl-x').onclick = () => {
      try { localStorage.setItem(ORDERS_KEY(), '1'); } catch (e) {}
      sfx('click'); renderOrders();
    };
    finCardEl.querySelectorAll('[data-ord]').forEach(b => {
      const s = steps.find(x => x.id === b.dataset.ord);
      // arm the prop tool with THIS prop picked (tier/drawer follow), so the next deck click drops it
      b.onclick = () => {
        if (!s) return;
        selectTool('prop');
        propQuery = grantLabelOf({id:s.id}); propTier = 'functional'; propCat = s.cat; propType = s.id;
        renderPalette(); setHint();
        flashTip(null, s.label + ' selected', true);
        sfx('click');
      };
    });
  }

  function renderFinCard() {
    if (!root || !running) return;
    if (!finEngaged && !tutorialCoaching()) { ordersHide(); return; }
    // Workflow setup stays with workflow tools while decorating stays unobstructed.
    if(!['belt','line'].includes(tool)) { if(finCardEl)finCardEl.style.display='none'; return; }
    if(finCardEl)finCardEl.style.display='';
    bumpUi();   // the card is about to be re-measured/rebuilt — drop its pinned-position memo
    const c = finPick();
    if (!c) { renderOrders(); return; }   // no line yet → the stage BEFORE it, in the same slot
    finComp = c;
    const st = finState(c);
    // the card is titled with the LINE'S NAME (the intake's saved label — line naming); unnamed lines
    // keep the generic header. In the sig so a rename repaints without a topology edit.
    const lname = lineNameOf(c);
    const overview = workflowReadout(c, valPlan, agentLabelFor);
    // ② DONE SAYS WHICH START IT FOUND (wave 2, build-12): another line's SEND TO feeds it (named by the one line name), else an
    // automatic start of THIS line is configured (lineStartsHere) — work that merely arrived (a run count) starts nothing and never ticks
    // ② (fedLines is the compiled SEND TO, Pipeline.fedLineIds). The old X-or-Y sentence could not say which of its two claims held. A sender counts only if it can run (Pipeline.lineSenders: it has an INBOX — a
    // fragment's hand-off feeds nothing), so it always has a floor name (wave 2 repair: an INBOX-less sender read FED BY ANOTHER LINE)
    const senders = [...new Set(((typeof Pipeline !== 'undefined' && Pipeline.lineSenders) ? Pipeline.lineSenders(valPlan, c.key) : [])
      .map(id => station && station.lineName && station.lineName(id)).filter(Boolean))];
    // ③ posts the same paid job as the panel's SEND A REAL JOB: it says the same about a SEND TO (finOnwardPromise) — in the sig, so
    // setting a SEND TO, or its target losing its crew or spending its limit, repaints the card
    const onward = st.crewLeft === 0 ? finOnwardPromise(c) : '';
    const sig = [c.key, st.crewLeft, st.hasIntake, st.feed.known, st.feed.fed, st.autoStart, st.feedDone, st.schedOff, finSample, lname || '', overview.compact, finSampleRes ? finSampleRes.key + ':' + finSampleRes.stamp : '', senders.join(','), onward].join('|');
    if (!finCardEl) {
      finCardEl = document.createElement('div');
      root.appendChild(finCardEl);
    } else if (sig === finSig) return;
    // ...and always restate the class: this element is SHARED with STATION ORDERS (the stage before
    // a line exists), so handing off from orders to the line card has to shed `refit-orders` or the
    // card keeps orders' styling — and positionFinCard keys its top-right parking on that class.
    finCardEl.className = 'refit-finline';
    finSig = sig;
    const crewDone = st.crewLeft === 0;
    const crewTxt = crewDone ? '✓ AGENTS ASSIGNED' : '① ASSIGN STEP AGENTS — ' + st.crewLeft + ' TO GO';
    const feedTxt = finFeedText(st, senders);   // ② — what STARTS the line (finFeedText)
    // the sample RESULT belongs to the line it rode (finSampleRes.key) — another line's card shows none
    const sr = (finSampleRes && finSampleRes.key === c.key) ? finSampleRes : null;
    const sampleOn = finSample === true && crewDone && !(sr && sr.pending);
    const sampleTip = finSample !== true ? 'coming online soon' : (crewDone ? 'run ONE real job through the whole line (your INBOX test job, if you wrote one)' + (onward ? '. ' + onward : '') : 'Assign each step an agent first');
    // (org g7 D1, final round) the ③ label rides ONE span: .fl-step is a flex row, and a bare text run beside the amber
    // .fl-again span became its own flex item whose trailing space collapsed — '✓ DELIVERED —SEND ANOTHER'
    // (org D4/D5) the title is FINISH + the line's own name (one separator at most — a preset's name carries its own ·), FINISH SETUP
    // unnamed; the done row says ✓ DELIVERED like WORKFLOWS — both stay on the narrow card's lines instead of stranding a word
    const sampleTxt = (sr && sr.pending) ? (sr.phase === 'post' ? '③ POSTING LINE…' : '③ RUNNING — THE JOB IS RIDING THE LINE…') : (sr && sr.view && sr.view.ok) ? '✓ DELIVERED — SEND ANOTHER' : '③ SEND A REAL JOB';
    finCardEl.innerHTML = `
      <div class="fl-head"><span class="fl-title">▸ FINISH ${lname ? esc(lname.toUpperCase()) : 'SETUP'}</span><button type="button" class="bb sm fl-x" title="dismiss for this line">✕</button></div>
      <div class="fl-overview">${esc(overview.compact)}</div>
      <button type="button" class="bb fl-step" data-act="overview">EDIT STEPS & RESULT</button>
      <button type="button" class="bb fl-step${crewDone ? ' done' : ''}" data-act="crew"${crewDone ? ' disabled' : ''}>${esc(crewTxt)}</button>
      <button type="button" class="bb fl-step${st.feedDone ? ' done' : ''}" data-act="feed"${st.feedDone ? ' disabled' : ''}>${esc(feedTxt)}</button>
      <button type="button" class="bb fl-step${sampleOn ? '' : ' off'}${sr && sr.view && sr.view.ok ? ' done' : ''}" data-act="sample" title="${esc(sampleTip)}"><span class="fl-lbl">${esc(sampleTxt).replace('SEND ANOTHER', '<span class="fl-again">SEND ANOTHER</span>')}</span></button>
      ${sr && sr.view ? finSampleHTML(sr.view) + finOnwardHTML(sr) : onward ? '<div class="fl-result fl-onward"><span class="fl-result-k">SEND TO</span> ' + esc(onward) + '</div>' : ''}`;
    finCardEl.querySelector('.fl-x').onclick = () => { finMark(station, c.key, 'dis'); sfx('click'); renderFinCard(); };
    const example = currentPresetExample();
    const overviewButton = finCardEl.querySelector('[data-act="overview"]');
    if (example?.key === c.key) overviewButton.textContent = 'SET UP ' + String(example.title).toUpperCase();
    overviewButton.onclick = () => { if (example?.key === c.key) openPresetExample(); else if (c.intakes.length) openFlowCard(c.intakes[0]); else if (c.bays.length) openStepCard(c.bays[0].propId); };
    const bCrew = finCardEl.querySelector('[data-act="crew"]');
    if (bCrew && !crewDone) bCrew.onclick = () => finFocusCrew(c);
    const bFeed = finCardEl.querySelector('[data-act="feed"]');
    if (bFeed && !st.feedDone) bFeed.onclick = () => finOpenFeed(c);
    const bSample = finCardEl.querySelector('[data-act="sample"]');
    if (bSample) bSample.onclick = () => { if (sampleOn) finRunSample(c); };
  }
  // ① — center the camera on the next unbound dock and open the SAME picker a direct click opens
  function finFocusCrew(c) {
    const b = finState(c).unbound[0];
    if (!b || !cacheGeo) return;
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, t = T();
    panX = cv.width / 2 - (b.x + o.tx + b.w / 2) * t * zoom;
    panY = cv.height / 2 - (b.y + o.ty + b.h / 2) * t * zoom;
    sfx('click');
    openStepCard(b.propId, null);
  }
  // ② — ONE SURFACE (inbox-trigger, 2026-08-05): the line's own INBOX card carries the TRIGGER zone
  // (feed truth, this line's routines, create-right-here, and the CHANNELS/AUTOMATION doors), so the FEED
  // step opens THAT — the trigger is defined on the floor, not behind a blind hop to the messaging term.
  // A line with no intake keeps the old door: the CHANNELS panel is the only feed surface it has.
  function finOpenFeed(c) {
    sfx('click');
    const iid = c && c.intakes && c.intakes[0];
    if (iid && station.propById(iid)) { openFlowCard(iid); return; }
    close();
    if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('messaging');
  }
  // ③ — Phase 4's seam, fired only when detected present + docks crewed. The card claims nothing the
  // harness didn't answer: success/refusal both surface as the server's own verdict.
  /* THE RESULT IS RENDERED, NOT FLASHED (2026-08-22 stranded-user sweep): the route answers only after the
     line DELIVERED (or refused) with the REAL recorded outcome — runs, replies, totalUsd, delivered — and the
     card used to discard all of it behind a 1.3s "dispatched — watch the line". Now the answer lives on the
     card: the stages that ran (agent names, line order), the real dollars, the first 80 chars the line
     delivered, and ③ ticks ONLY on `delivered` (the server's own verdict); a refusal shows the server's
     reason. Scoped to the line it rode; a new sample replaces the last readout. */
  let finSampleRes = null;   // { key, stamp, pending } | { key, stamp, view }
  function finSampleHTML(v) {
    if (!v) return '';
    // a STOPPED job is the Commander's own act, not a refusal: it says so, with what already ran and what it cost
    if (v.stopped) return '<div class="fl-result stopped"><div><span class="fl-result-k">STOPPED</span> ' + esc(String(v.reason || '').replace(/^stopped\s*[—-]\s*/i, '') || 'you stopped this job') + '</div>'
      + (v.stages.length ? '<div><span class="fl-result-k">RAN</span> ' + esc(v.stages.join(' ▸ ')) + '</div>' : '')
      + (v.usd != null ? '<div><span class="fl-result-k">COST</span> $' + esc(v.usd.toFixed(4)) + '</div>' : '') + '</div>';
    if (!v.ok) return '<div class="fl-result bad"><span class="fl-result-k">REFUSED</span> ' + esc(v.reason || 'no reason given') + '</div>';
    return '<div class="fl-result">'
      + '<div><span class="fl-result-k">RAN</span> ' + esc(v.stages.length ? v.stages.join(' ▸ ') : '(no stage recorded)') + '</div>'
      + (v.usd != null ? '<div><span class="fl-result-k">COST</span> $' + esc(v.usd.toFixed(4)) + '</div>' : '')
      + (v.reply ? '<div class="fl-result-reply"><span class="fl-result-k">SAID</span> ' + esc(v.reply) + '</div>' : '')
      + '</div>';
  }
  /* ③ STARTS ANOTHER LINE'S PAID JOB, SAID HERE TOO (conveyor-ui-01, wave-2 repair): the FINISH card's RUN ONE REAL JOB posts the
     same /api/routing/sample job as the Workflow panel's key, and a SEND TO on this line hands a clean result to the next line's
     crew — a second job at that line's cost. Both surfaces say it from ONE reading (WorkflowLine.onwardPromise / onwardResult over
     the plan the floor compiled, valPlan): before the job, where a clean result is sent on — or that the target would refuse it now
     (no agent on its first BAY, its daily limit spent); after it, SENT ON / NOT SENT ON from the job's own record, else only what
     the floor proves. A line is named by the floor's one rule (World.lineName). */
  function finOnwardPromise(c) {
    const W = typeof WorkflowLine !== 'undefined' ? WorkflowLine : null, w = opts.world;
    if (!c || !valPlan || !W || !W.onwardPromise || typeof Pipeline === 'undefined') return '';
    const nameOf = k => { const r = (valPlan.sendTo || {})[k]; return r ? Pipeline.lineWord((w && w.lineName && w.lineName(String(r.toLine))) || '', 'another line') : null; };
    return W.onwardPromise(valPlan, c.key, (c.outboxes || []).length, Pipeline, { nameOf, statsOf: w && w.lineStatsFor ? id => w.lineStatsFor(id) : null }).trim();
  }
  function finOnwardHTML(sr) {
    const W = typeof WorkflowLine !== 'undefined' ? WorkflowLine : null, w = opts.world;
    const o = W && W.onwardResult && valPlan && typeof Pipeline !== 'undefined' ? W.onwardResult(sr, valPlan, Pipeline, w && w.lineName ? id => w.lineName(id) : null) : null;
    if (!o) return '';
    const to = esc((o.names || []).join(' and '));
    if (o.kind === 'refused') return '<div class="fl-result bad"><span class="fl-result-k">NOT SENT ON</span> to ' + esc(o.name) + ' — ' + esc(o.why) + '</div>';
    if (o.kind === 'sent') return '<div class="fl-result"><span class="fl-result-k">SENT ON</span> to ' + esc(o.name) + ' — its crew works this result next, at its own cost</div>';
    if (o.kind === 'sends') return '<div class="fl-result"><span class="fl-result-k">SEND TO</span> this line sends its finished work on to ' + to + ' — WORKFLOWS › LAST JOBS shows that line’s job, or why it was not sent</div>';
    return '<div class="fl-result"><span class="fl-result-k">SEND TO</span> an OUTBOX on this line sends on to ' + to + ' — if this job was handed on, WORKFLOWS › LAST JOBS shows that line’s job, or why it was not sent</div>';
  }
  /* POST THE LINE BEFORE RUNNING IT (2026-08-22). BUILD MODE freezes the world, so the plan the sidecar routes by
     is the one posted at the LAST BUILD MODE CLOSE — a sample fired right after an edit ran the OLD line while
     the floor drew the new one. Now the sample awaits World.syncPlan() (recompile if dirty + the server's
     verdict on the POST) and dispatches only once the sidecar holds THIS floor; a line with blocking
     compiler errors, or a POST the sidecar never answered, is REFUSED with the floor's own nag copy.
     RUN-GATE-PURE-BEGIN (extraction marker — test/refit-run-gate.test.js evals finPlanGate with a stubbed
     `opts.world` + VAL_LABEL; keep it free of other module state). */
  function finPlanGate(c) {
    const w = opts.world;
    if (!w || typeof w.syncPlan !== 'function') return Promise.resolve(null);
    let p; try { p = w.syncPlan(); } catch (_) { p = null; }
    return Promise.resolve(p).then(s => {
      if (!s) return null;
      const errs = (s.errors || []);
      if (errs.length) return { refuse: 'line not posted — fix the floor first: ' + errs.map(e => VAL_LABEL[e.code] || e.code).filter((v, i, a) => a.indexOf(v) === i).join(' · ') };
      if (s.refusedHash && s.refusedHash === s.lastHash) return { refuse: 'the station refused this line — fix the nags on the floor first' };
      if (s.stale || s.inflight || s.retryPending) return { refuse: 'line not posted — sidecar unreachable, the old line was NOT run' };
      return null;
    }, () => ({ refuse: 'line not posted — the old line was NOT run' }));
  }
  /* RUN-GATE-PURE-END */
  function finRunSample(c, options = {}) {
    if (finSampleRes?.pending) return;
    sfx('click');
    const key = c.key;
    finSampleRes = { key, stamp: Date.now(), pending: true, phase: 'post', exampleSignature:options.exampleSignature };   // phase: 'post' (posting line…) → 'run' (running)
    finSig = ''; renderFinCard();
    options.onUpdate?.();
    /* what the server answered is KEPT (2026-09-30 — ease of use): every stage's run (the panel reads each step's own reply from
       it), the job's stream, and the WHOLE delivered text (the hub delivers it in 4000-character chunks: joined, never just the last
       one). THE OUTBOX IS TOLD: the panel promised "the result lands in the OUTBOX" but only COMMS' INBOX card folded a delivered
       row into the OUTBOX's ledger — a job sent from the panel never showed there. Same rule as chat.js: a clean 'done' only. */
    const settle = (view, response) => {
      let folded = false;
      if (view.ok && response && response.delivered && response.delivered.reason === 'done') { try { if (typeof ReturnStore !== 'undefined' && ReturnStore.foldRow) folded = !!ReturnStore.foldRow(response.delivered); } catch (_) {} }
      finSampleRes = { key, stamp: Date.now(), view, exampleSignature:options.exampleSignature, output: Array.isArray(response?.replies) ? response.replies.join('') : '',
        runs: Array.isArray(response?.runs) ? response.runs : [], streamId: response?.streamId || null, folded, text: options.text || '',
        // COUNTED IN SHIPPED? (rc walk #30) the server's own answer from the receipts the line's SHIPPED counts: true / false / null (unknown)
        shipped: response && typeof response.shipped === 'boolean' ? response.shipped : null,
        shippedWhy: response && response.shipped === false && typeof response.shippedWhy === 'string' ? response.shippedWhy : null,   // why not, only when the server proved it
        // SEND TO (conveyor-ui-01): the job's own link to the next line's job (sentTo), else the line's live SEND TOs — the panel says which
        sentTo: (response && response.sentTo && typeof response.sentTo === 'object') ? response.sentTo : null, onward: Array.isArray(response?.onwardDestinations) ? response.onwardDestinations : [] };
      finSig = ''; if (running) renderFinCard(); options.onUpdate?.(); sfx(view.ok ? 'chime' : 'bad');
    };
    const bad = reason => ({ ok: false, stages: [], usd: null, reply: '', reason });
    finPlanGate(c).then(gate => {
      if (gate && gate.refuse) { settle(bad(gate.refuse)); return; }
      finSampleRes = { key, stamp: Date.now(), pending: true, phase: 'run', exampleSignature:options.exampleSignature }; finSig = ''; if (running) renderFinCard(); options.onUpdate?.();
      try {
        fetch(finApi('/api/routing/sample'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line: key, ...(options.text ? {text:options.text} : {}) }) })
          .then(r => r.json().catch(() => null).then(j => settle(sampleResultView(j, r.status, agentLabel),j)))
          .catch(() => settle(bad('sample failed — sidecar unreachable')));
      } catch (e) { settle(bad('sample failed — sidecar unreachable')); }
    });
  }
  /* ■ STOP (2026-09-29): RUN ONE REAL JOB could not be stopped short of the station-wide E-STOP. The sidecar kills THIS job's
     runs (POST /api/routing/sample/stop — the E-STOP kill scoped to the sample hub) and the in-flight POST settles with the
     server's stopped verdict, so the readout says STOPPED from the server's answer, never on the click alone. Until it
     settles the button reads STOPPING… */
  function finStopSample() {
    if (!finSampleRes || !finSampleRes.pending || finSampleRes.phase !== 'run') return Promise.resolve({ ok: false, error: 'no job is riding the line' });
    finSampleRes.stopping = true; finSig = ''; if (running) renderFinCard();
    const undo = j => { if (finSampleRes && finSampleRes.pending) { finSampleRes.stopping = false; finSig = ''; if (running) renderFinCard(); } return j; };
    return fetch(finApi('/api/routing/sample/stop'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(r => r.json().catch(() => null).then(j => (j && j.ok) ? j : undo(j || { ok: false, error: 'the stop was not accepted (HTTP ' + r.status + ')' })))
      .catch(() => undo({ ok: false, error: 'sidecar unreachable — the job may still be running (E-STOP stops everything)' }));
  }
  // per-frame: hide while anything coach-like is up (same gate family as the first ride), else pin
  // the card beside the line's bounding box in screen space (the flashTip/clientX coordinate basis).
  /* PIN ONLY WHEN SOMETHING MOVED (2026-08-08 perf pass). This ran three getBoundingClientRects and
     two style writes on EVERY frame — the writes dirty layout, so the next frame's reads are forced
     layouts, i.e. the loop paid for its own invalidation forever. The card's position is a pure
     function of a handful of values: the camera, the window, BUILD MODE's own chrome (dock width / card
     size, tracked by uiVer), the text-size zoom, and which line it is anchored to. Sign those; an
     unchanged signature means the pin is already correct and the frame owes it nothing.
     The coach gate CLEARS the signature so the card is always re-pinned when it comes back. */
  let finPosSig = '';
  let uiVer = 1;   // bumped wherever BUILD MODE's own DOM geometry can move — see bumpUi()
  function bumpUi() { uiVer++; finPosSig = ''; }
  /* the coach's bubble rect (tutorial.js `.tut-coach`, a fixed body child) — VISUAL px. While a coach is up
     the checklist used to vanish entirely; now it STACKS under the bubble (the first-run guide card is the
     one surface that still hides it: that card IS the whole screen). */
  function coachRect() {
    const el = document.querySelector('.tut-coach'); if (!el) return null;
    const r = el.getBoundingClientRect(); return (r.width && r.height) ? r : null;
  }
  function positionFinCard() {
    if (!finCardEl) return;
    // Routing advice belongs to workflow editing, not the decoration/material inventory.
    if (tool !== 'belt' && tool !== 'line' && !tutorialCoaching()) {
      finCardEl.style.display = 'none'; finPosSig = ''; return;
    }
    if (root && root.querySelector('.refit-firstrun')) { finCardEl.style.display = 'none'; finPosSig = ''; return; }
    const coach = tutorialCoaching() ? coachRect() : null;
    const coachKey = coach ? '|c' + Math.round(coach.left) + ',' + Math.round(coach.top) + ',' + Math.round(coach.right) + ',' + Math.round(coach.bottom) : '';
    const c = finComp;
    /* ORDERS mode has no line to anchor to (that is the whole point of it), so it parks in the top
       right of the glass — clear of the left dock and of the action deck above. FINISH THE LINE
       still tracks its own line's bbox below. */
    if (!c && finCardEl.classList.contains('refit-orders')) {
      if (!cv) return;
      finCardEl.style.display = '';
      const osig = 'o|' + uiVer + '|' + window.innerWidth + '|' + window.innerHeight + '|' + U.uiZoom() + coachKey;
      if (osig === finPosSig) return;
      const r0 = cv.getBoundingClientRect();
      if (!r0.width) return;
      finPosSig = osig;
      const z = U.uiZoom(), cr0 = finCardEl.getBoundingClientRect();
      const wpo = root.querySelector('.wf-panel')?.getBoundingClientRect();
      const ox = Math.min(r0.right, (wpo && wpo.width && wpo.width < window.innerWidth * 0.9) ? wpo.left : r0.right) - (cr0.width || 236 * z) - 14 * z;
      let oy = r0.top + 58 * z;
      if (coach && coach.right > ox && coach.bottom > oy) oy = coach.bottom + 10 * z;   // stack under the bubble
      finCardEl.style.left = Math.round(ox / z) + 'px';
      finCardEl.style.top = Math.round(oy / z) + 'px';
      return;
    }
    if (!c || !c.bbox || !cacheGeo || !cv) return;
    finCardEl.style.display = '';
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, t = T();
    const lsig = 'l|' + uiVer + '|' + zoom + '|' + panX + '|' + panY + '|' + t + '|' + o.tx + ',' + o.ty
      + '|' + window.innerWidth + '|' + window.innerHeight + '|' + U.uiZoom()
      + '|' + c.key + '|' + c.bbox.x1 + ',' + c.bbox.y1 + ',' + c.bbox.x2 + ',' + c.bbox.y2 + '|' + geoVer + coachKey;   // geoVer: a machine placed under the card moves it
    if (lsig === finPosSig) return;
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    finPosSig = lsig;
    const uiz = U.uiZoom();
    const sx = w => r.left + (w * zoom + panX) * (r.width / cv.width);
    const sy = w => r.top + (w * zoom + panY) * (r.height / cv.height);
    const cr = finCardEl.getBoundingClientRect();
    const w = cr.width || 232 * uiz, h = cr.height || 118 * uiz;
    // NEVER over the tool dock (the never-blocks-editing law): a left-sidebar dock raises the floor x
    const dock = root.querySelector('.refit-dock');
    let minX = 8, maxY = window.innerHeight - h - 8;
    const wpr = root.querySelector('.wf-panel')?.getBoundingClientRect();
    const edgeR = (wpr && wpr.width && wpr.width < window.innerWidth * 0.9) ? wpr.left : window.innerWidth;   // the docked Workflow panel is a wall
    if (dock) {
      const d = dock.getBoundingClientRect();
      if (d.width < window.innerWidth * 0.6 && d.left < window.innerWidth / 2) minX = Math.max(minX, d.right + 10);
      else maxY = Math.min(maxY, d.top - h - 10);
    }
    const rightX = sx((c.bbox.x2 + 1 + o.tx) * t) + 14;
    const leftX = sx((c.bbox.x1 + o.tx) * t) - w - 14;
    const topY = sy((c.bbox.y1 + o.ty) * t) - 4;
    const cands = [];
    if (rightX + w <= edgeR - 8) cands.push({ x: rightX, y: topY });                                            // beside, to the right
    if (leftX >= minX) cands.push({ x: leftX, y: topY });                                                        // beside, to the left
    cands.push({ x: sx((c.bbox.x2 + 1 + o.tx) * t) - w, y: sy((c.bbox.y2 + 1 + o.ty) * t) + 12 });              // under the line
    cands.push({ x: sx((c.bbox.x2 + 1 + o.tx) * t) - w, y: sy((c.bbox.y1 + o.ty) * t) - h - 12 });              // above it
    const clampX = v => Math.max(minX, Math.min(v, edgeR - w - 8)), clampY = v => Math.max(56, Math.min(v, maxY));
    /* NEVER OVER A MACHINE (2026-09-28 retest): beside-the-line is DOWNSTREAM, where a builder places the next machines —
       the card landed on the JOINER and OUTBOX a first-time user had placed and was about to belt. The card is advice; the
       machines are the work. The first spot that covers no workflow machine wins; the old order is the fallback. */
    const FIN_AVOID = { intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 };
    const boxes = station.props().filter(p => FIN_AVOID[p.t]).map(p => ({ l: sx(p.x * t), t: sy(p.y * t), r: sx((p.x + (p.w || 1)) * t), b: sy((p.y + (p.h || 1)) * t) }));
    const spots = cands.map(q => ({ x: clampX(q.x), y: clampY(q.y) }));
    const clear = q => !boxes.some(m => q.x < m.r && q.x + w > m.l && q.y < m.b && q.y + h > m.t);
    let { x, y } = spots.find(clear) || spots[0];
    // a coach bubble over the same spot: stack the checklist UNDER it (never hide it, never cover it)
    if (coach && x < coach.right && x + w > coach.left && y < coach.bottom && y + h > coach.top) {
      y = Math.min(coach.bottom + 10, maxY);
    }
    finCardEl.style.left = Math.round(x / uiz) + 'px';
    finCardEl.style.top = Math.round(y / uiz) + 'px';
  }
  /* FIRST SHIP BOOKKEEPING (2026-10-12) — per station+line, `shipped` = this line's FIRST SHIP is spent. world.js calls these with
     BUILD MODE CLOSED. THE LIVE STATION WINS: close() never nulls the module-level `station`, so preferring it booked a line
     against whatever station the last BUILD MODE session held (load a different save and the next shipment marked a line on the
     station you are no longer standing in). opts.getStation() is the app's live station; the stale module field is only the
     fallback for a harness that injected no getter. A crate sinking at a chute books NOTHING here: it proves no shipment (a
     direct COMMS order to a line's agent rides one down that line's belt too), so it neither spends FIRST SHIP nor touches the
     finish card. */
  function finLiveStation() {
    const live = (opts && typeof opts.getStation === 'function') ? opts.getStation() : null;
    const st = live || station;
    return st || null;
  }
  // has this line's FIRST SHIP been said (or quietly learned)? — asked before any read, so a spent line costs nothing
  function lineShipSpent(lineId) {
    const st = finLiveStation();
    if (!st || lineId == null || lineId === '') return false;
    const r = finRead(st)[String(lineId)];
    return !!(r && r.shipped);
  }
  // the shipment record shows this line already SHIPPED (this window missed it, another window said it, or it shipped before this
  // page): spend its FIRST SHIP quietly — no toast — and let the finish card stand down if nothing is left to do
  function markLineShipped(lineId) {
    const st = finLiveStation();
    if (!st || lineId == null || lineId === '' || lineShipSpent(lineId)) return false;
    finMark(st, String(lineId), 'shipped');
    if (running) renderFinCard();
    return true;
  }
  /* FIRST SHIP (2026-10-12): the gold toast + milestone a line earns the first time it SHIPS — never a crate animation. world.js
     calls this from the executor's terminal receipt (chain.js workitem.delivered { box: 'line-output', lineId, outboxId }: a clean
     job of THAT line reached THAT OUTBOX) once the shipment record shows the line went from no shipment to its first
     (noteFirstShip). -> { first: true, name, tiles } once per line, else null (a line no longer on the floor, a receipt whose
     OUTBOX is now on another line, a line whose FIRST SHIP is spent). */
  function noteLineShipped(outboxId, lineId) {
    const live = (opts && typeof opts.getStation === 'function') ? opts.getStation() : null;
    const st = live || station;
    if (!st || !outboxId || typeof Pipeline === 'undefined' || !Pipeline.lineComponents) return null;
    let geo = null;
    try { geo = st.projectGeometry(); } catch (e) { return null; }
    const c = (Pipeline.lineComponents(geo) || []).find(k => (k.outboxes || []).indexOf(outboxId) >= 0);
    if (!c || (lineId != null && String(lineId) !== String(c.key))) return null;
    const reg = finRead(st);
    if (reg[c.key] && reg[c.key].shipped) return null;
    finMark(st, c.key, 'shipped');
    if (running) renderFinCard();   // the line shipped: its card stands down unless a step is still left to do
    // (the one line name — worldmodel.lineName: its first NAMED INBOX, else its letter; never the first INBOX in geo order or a raw key)
    const ip = (geo.props || []).find(p => c.intakes.includes(p.id));
    return { first: true, name: (st.lineName && st.lineName(c.key)) || Pipeline.lineWord(ip && ip.label, ip && st.lineLetter ? 'LINE ' + st.lineLetter(ip.id) : 'THIS LINE'), tiles: c.tiles };
  }

  /* ---------- AIRLOCK door-state picker: cycle a room's SPATIAL seal (floor containment, NOT capability
     isolation). closed/jammed SEAL the room — its agent's BODY can't path in or out (a staging seal, the
     unmerged-branch metaphor); open = connected to trunk. Sealing does NOT change the agent's run/tools/caps
     — the BAY governs capability. */
  /* ---------- THE ROOM CARD (2026-08-07) ----------
     SELECT's contract was "click a machine to open it", and clicking a ROOM — the thing you spend
     build mode making — did nothing at all. The most-clicked surface in the editor was a dead
     click, and `station.renameRoom` had shipped in the model with no UI anywhere to reach it.
     This card is the room's own sheet: what it is, how big, what it's made of, and the three verbs
     that already existed (rename · re-deck · delete), each routed through the same mutation API the
     tools use — no new model surface, no state of its own. */
  /* A ROOM IS SELECTED LIKE A PROP (2026-10-01 build-mode upgrade, phase 2). Clicking a room's floor used to open a sheet in
     the middle of the screen (rename, floor, move, delete). The room is now a SELECTION: gold outline and edge handles on the
     floor, and its card docks above the library like a prop's — name, size, RESIZE / FLOOR / FURNISH / CLEAR / DELETE (a drag inside it moves it).
     See THE ROOM CARD below. */
  function openRoomCard(roomId, ev) {
    if (!root) return;
    cardCloseAll();
    selectRoom(roomId);
  }
  /* A HALLWAY JOINS TWO ROOMS (the station builder's rule, now Build Mode's too): a room move, nudge, resize or delete that
     leaves a hallway leading nowhere is refused and nothing changes — Build Mode stranded hallways the builder refuses. A
     hallway already stranded before the edit is not this edit's doing. One edit, one undo (transact). */
  function keepsHalls(op) {
    if (typeof StationBuilder === 'undefined' || !StationBuilder.strandedHalls || typeof station.transact !== 'function') return op();
    const before = new Set(StationBuilder.strandedHalls(station));
    return station.transact(() => {
      const r = op(); if (!r || !r.ok) return r;
      const now = StationBuilder.strandedHalls(station).filter(id => !before.has(id));
      if (!now.length) return r;
      const h = station.roomById(now[0]);
      return { ok: false, error: 'STRANDS_HALL', msg: ((h && h.name) || 'A hallway') + ' would lead nowhere · keep it joined to two rooms, or delete the hallway first' };
    });
  }
  // the ONE room-removal path the card and the DELETE tool both take (flash, undo nudge, honest refusal)
  function doDeleteRoom(roomId, ev) {
    const rm = station.roomById(roomId);
    const on = rm ? station.props().filter(p => rm.rects.some(r => p.x <= r.x2 && p.x + (p.w || 1) - 1 >= r.x1 && p.y <= r.y2 && p.y + (p.h || 1) - 1 >= r.y1)).map(p => Object.assign({}, p)) : [];
    if(warnSendCuts(on.map(p=>p.id),ev,roomId)) return false;   // (the room stays selected: "repeat DELETE" means the very next Delete)
    const res = keepsHalls(() => station.removeRoom(roomId));
    if (res && res.ok) { if (rm) pushFlash(rm.rects, true); on.forEach(p => vanishProp(p)); flashUndo(); flashTip(ev, 'deleted — UNDO to restore', true); sfx('click'); }
    else if (res && res.error === 'SPAWN_ROOM') { flashTip(ev, 'spawn room — can’t delete (select it and drag it to move it)'); sfx('bad'); }
    else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
    return !!(res && res.ok);
  }

  function openDoorPicker(propId, ev) {
    if (!root) return;
    const p = station.propById(propId); if (!p || p.t !== 'airlock') return;
    cardCloseAll();
    const cur = p.door || 'open';
    const room = station.roomAt(p.x, p.y);
    const isTrunk = !!(room && typeof station.doc === 'function' && station.doc().meta.trunkRoomId === room);
    const STATES = [
      { id: 'closed', label: '▦ SEALED' },
      { id: 'open', label: '▢ OPEN' },
      { id: 'jammed', label: '✖ JAMMED' },
    ];
    const rows = STATES.map(s => `<button type="button" class="bb sm door-state${s.id === cur ? ' active' : ''}" data-st="${s.id}">${s.label}</button>`).join('');
    const g = document.createElement('div');
    g.className = 'refit-guide refit-door-picker';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ AIRLOCK — ROOM SEAL</h3>
        <ul><li>A <b>SEALED</b> room is contained on the floor — its agent’s body can’t path in or out (a staging seal, the unmerged-branch look).</li>
        <li><b>OPEN</b> = connected to the trunk hub · <b>JAMMED</b> = a merge conflict (sealed).</li>
        <li>A spatial seal — it doesn’t change what the agent’s run can do; its tools &amp; permissions come from its BAY.</li>
        ${isTrunk ? '<li><b>This is the trunk room</b> — it never seals (the integration hub).</li>' : ''}</ul>
        <div class="refit-agents">${rows}</div>
        <div class="refit-actions">
          <button type="button" class="btn-sm" id="door-cancel">CANCEL</button>
        </div>
      </div>`;
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    g.querySelectorAll('.door-state').forEach(b => b.onclick = () => {
      const res = station.setDoorState(propId, b.dataset.st);
      if (res && res.ok) { sfx('click'); flashTip(ev, 'airlock → ' + res.door, true); closeP(); }
      else sfx('bad');
    });
    g.querySelector('#door-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  /* ---------- camera + sizing ---------- */
  function resize() {
    if (!cv) return;
    const previousWidth = cv.width, previousHeight = cv.height;
    bumpUi();   // the glass moved — every memoized chrome measurement is stale (positionFinCard)
    dpr = window.devicePixelRatio || 1;
    // TEXT SIZE zoom parity with world.js resize(): body.style.zoom shrinks layout px, so bake the
    // factor back in or the BUILD MODE floor upscales soft. Picking stays rect-ratio-based (canvasPoint).
    const uiz = (() => { const z = parseFloat(document.body && document.body.style ? document.body.style.zoom : ''); return z > 0 ? z : 1; })();
    cv.width = Math.max(1, Math.round(cv.clientWidth * dpr * uiz));
    cv.height = Math.max(1, Math.round(cv.clientHeight * dpr * uiz));
    updateSafetyClearance();
    if (running && (cv.width !== previousWidth || cv.height !== previousHeight)) fitCamera();
  }
  // the chrome-occluded margins of the canvas (device px): the build panel (left sidebar on
  // desktop, bottom sheet on narrow screens) + the top bar — so FIT frames the station in the
  // VISIBLE viewport instead of centering half of it behind the panel.
  /* viewInsets reads three getBoundingClientRects — cheap once, but it is now consulted from the
     draw loop (the gesture badge and the invitation clamp to the VISIBLE glass, not the raw
     canvas), and three forced layouts per frame is exactly how a canvas app starts stuttering.
     The measurement cannot change within a frame, so memoize it for the frame; frame() drops it. */
  let insMemo = null;
  const viewInsetsFrame = () => (insMemo || (insMemo = viewInsets()));
  function viewInsets() {
    const out = { l: 0, t: 0, b: 0, r: 0 };
    if (!cv || !root) return out;
    const c = cv.getBoundingClientRect();
    if (!c.width || !c.height) return out;
    const sx = cv.width / c.width, sy = cv.height / c.height;
    const top = root.querySelector('.refit-top');
    if (top) out.t = Math.max(0, top.getBoundingClientRect().bottom - c.top) * sy;
    const dock = root.querySelector('.refit-dock');
    if (dock) {
      const d = dock.getBoundingClientRect();
      if (window.matchMedia('(max-width: 700px)').matches) out.b = Math.max(0, c.bottom - d.top) * sy;
      else if (!dock.classList.contains('is-collapsed')) out.l = Math.max(0, d.right - c.left) * sx;
    }
    const wp = root.querySelector('.wf-panel');
    if (wp) {
      const w = wp.getBoundingClientRect();
      if (w.width && w.height) {
        if (w.width >= c.width * 0.9) out.b = Math.max(out.b, (c.bottom - w.top) * sy);   // narrow: a bottom sheet
        else out.r = Math.max(0, c.right - w.left) * sx;
      }
    }
    return out;
  }
  function fitCamera() {
    const b = station.bounds(), t = T();
    const wx1 = b.minTx * t, wy1 = b.minTy * t, wx2 = (b.maxTx + 1) * t, wy2 = (b.maxTy + 1) * t;
    const ww = (wx2 - wx1) + 8 * t, wh = (wy2 - wy1) + 8 * t;
    const ins = viewInsets();
    const vw = Math.max(1, cv.width - ins.l - ins.r), vh = Math.max(1, cv.height - ins.t - ins.b);
    zoom = clamp(Math.min(vw / ww, vh / wh), MINZ, MAXZ);
    panX = ins.l + vw / 2 - (wx1 + wx2) / 2 * zoom;
    panY = ins.t + vh / 2 - (wy1 + wy2) / 2 * zoom;
  }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  function toWorldTile(ev) {
    const c = toCanvas(ev), t = T();
    return { tx: Math.floor(((c.x - panX) / zoom) / t), ty: Math.floor(((c.y - panY) / zoom) / t) };
  }
  function propAtEvent(ev) {
    const c=toCanvas(ev),x=(c.x-panX)/zoom,y=(c.y-panY)/zoom,t=T();
    const order=propDrawOrder(station.props());
    for(let i=order.length-1;i>=0;i--){
      const p=order[i],m=mountMap.get(p.id),dp=m?{...p,mount:m}:p;
      const hit=PropSprites.hitTest?PropSprites.hitTest(dp,x,y):null;
      if(hit===true || hit===null&&x>=p.x*t&&x<(p.x+p.w)*t&&y>=p.y*t&&y<(p.y+p.h)*t)return p.id;
    }
    return null;
  }
  function visibleBakeRect(g) {
    if (!cv || !g) return null;
    const t = g.TILE || T(), ox = g.origin.tx * t, oy = g.origin.ty * t;
    return {
      x: Math.max(0, (-panX) / zoom - ox),
      y: Math.max(0, (-panY) / zoom - oy),
      w: Math.ceil(cv.width / zoom),
      h: Math.ceil(cv.height / zoom)
    };
  }

  /* ---------- pointer interaction ---------- */
  const touchPts = new Map();
  let pinchLock = false, inspectTimer = null, clickMachine = null;
  const touchPair = () => { const p = Array.from(touchPts.values()); return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.max(10, Math.hypot(p[0].x-p[1].x, p[0].y-p[1].y)) }; };
  function panTrigger(ev) { return spaceHeld || ev.button === 1; }  // space-drag or middle-drag

  function onDown(ev) {
    lastClient = { x: ev.clientX, y: ev.clientY };
    hidePropCard();
    // right-button cancels an in-progress edit (and never starts one) — then DROPS the armed tool
    // back to SELECT. The browser context menu is already suppressed on the canvas (contextmenu
    // preventDefault in buildDOM), so right-click is a pure deselect gesture.
    /* THE HAND (2026-10-10): with something held (a piece, a dock key's armed tap, a PICK WHAT GOES HERE) right-click puts it
       down; with NOTHING held or armed and no gesture live, it removes the conveyor piece or belt under the pointer (removeAt —
       one undo, said on the floor). Anything else under it (furniture, bare floor) keeps the plain deselect. */
    if (ev.button === 2) {
      const held = !!(drag || connectFrom || connectTo || dupe || hand || touchArm || dropPick || tool !== 'select');
      if (drag) { releaseDrag(); hideTip(); } if (connectFrom || connectTo) { connectFrom = null; connectTo = null; hideTip(); } if (dupe) { dupe = null; hideTip(); setHint(); }
      if (hand || touchArm || dropPick) setHand(null, { silent: true });
      if (!held && removeAt(ev)) return;
      /* ...AND ON FURNITURE IT SAYS SO (2026-10-14, the busy-station walk: five right-clicks on a plant removed nothing and said
         nothing while the Conveyors strip read "right-click removes"). Right-click stays the conveyors' gesture; with nothing
         held, landing on furniture names what it removes and how this piece goes instead (click it, then Del). */
      if (!held) {
        const fid = propAtEvent(ev), fp = fid && station.propById(fid);
        if (fp && !isConveyorPiece(fp)) { sfx('bad'); flashTip(ev, String(propLabel(fp.t)).toUpperCase() + ' — RIGHT-CLICK REMOVES ONLY CONVEYOR PIECES AND BELTS · CLICK IT, THEN DEL', false); }
      }
      deselectTool(); return;
    }
    if (ev.pointerType === 'touch') {
      touchPts.set(ev.pointerId, toCanvas(ev));
      if (touchPts.size === 2 && !pinchLock) {
        releaseDrag(); clearTimeout(inspectTimer); hideTip();
        for (const id of touchPts.keys()) { try { cv.setPointerCapture(id); } catch (_) {} }
        const m = touchPair(); drag = { mode: 'pinch', d0: m.d, z0: zoom, wx: (m.x-panX)/zoom, wy: (m.y-panY)/zoom }; pinchLock = true; return;
      }
      if (touchPts.size > 1 || pinchLock) return;
    } else if (ev.isPrimary === false || dragPid != null && ev.pointerId !== dragPid) return;
    try { cv.setPointerCapture(ev.pointerId); dragPid = ev.pointerId; } catch (e) { dragPid = null; }
    if (panTrigger(ev)) { drag = { mode: 'pan', sx: toCanvas(ev).x, sy: toCanvas(ev).y }; cv.style.cursor = 'grabbing'; return; }
    if (ev.button !== 0) return;
    const w = toWorldTile(ev);
    // an armed tool that lets the selection move (pressMovesSelection): a press on the SELECTED piece — or a member of the selected
    // group — is SELECT's own press (a drag moves it, a click inspects it, exactly what CLICK-ON-MACHINE WINS did), never a stamp or a row
    if (tool !== 'select' && (selectedPropId || groupIds.length) && pressMovesSelection()) {
      const sid = propAtEvent(ev), sp = sid && station.propById(sid);
      if (sp && groupIds.includes(sp.id)) { drag = { mode: 'grouppress', propId: sp.id, start: w, cur: w, moved: false, add: false, cx: ev.clientX, cy: ev.clientY }; return; }
      if (sp && sp.id === selectedPropId) { drag = { mode: 'selectpress', propId: sp.id, start: w, cur: w, moved: false, add: false, cx: ev.clientX, cy: ev.clientY, sel: true }; return; }
    }
    if (tool === 'select') {
      // SELECT (the default): a click INSPECTS what's under it — machine → its editor/picker/flow
      // card, belt tile → where this lane goes. A drag across empty deck draws a SELECTION BOX (MANY AT ONCE).
      // THE HAND first: a dock key's armed tap (touch) removes / picks up; a piece in hand places (the PROP tool's own stamp)
      if (touchArm === 'remove') { if (!removeAt(ev)) { sfx('bad'); flashTip(ev, 'TAP A CONVEYOR PIECE OR A BELT TO REMOVE IT', false); } return; }
      if (touchArm === 'pipette') { pipette(ev, propAtEvent(ev)); return; }
      if (hand) { drag = { mode: 'propstamp', start: w, cur: w, moved: false, cx: ev.clientX, cy: ev.clientY }; return; }
      if (dropPick) { dropPick = null; renderSelection(); setHint(); }   // a press elsewhere lets the unanswered picker go
      // the SELECTED ROOM's edge handles come first: a drag on one resizes the room (THE ROOM CARD)
      const hd = selectedRoomId ? roomHandleAt(ev) : null;
      if (hd) { drag = { mode: 'roomresize', roomId: selectedRoomId, edge: hd.e, start: w, cur: w, moved: false }; return; }
      const pid = propAtEvent(ev);
      const p = pid && station.propById(pid);
      if (!p) clickMachine = null;   // a press off every machine lets the double-click latch go (wave 2, build-19)
      // a member of a selected group: a drag moves the whole group, a click (no drag) selects just it; Shift+click adds / drops one
      if (p && groupIds.includes(p.id)) { drag={mode:'grouppress',propId:p.id,start:w,cur:w,moved:false,add:ev.shiftKey,cx:ev.clientX,cy:ev.clientY};return; }   // cx/cy: a click that drifts across a tile edge is still a click (build-20)
      /* SELECT MOVES (10-11): the piece already SELECTED moves when dragged (sel) — unless it is a conveyor machine let go on another
         machine, which belts them (the target decides); an UNSELECTED workflow machine becomes a belt drag the moment it moves (THE
         HAND); furniture moves either way; Shift+drag moves any of them (onMove decides) */
      if (p) { drag={mode:'selectpress',propId:p.id,start:w,cur:w,moved:false,add:ev.shiftKey,cx:ev.clientX,cy:ev.clientY,sel:p.id===selectedPropId};return; }   // cx/cy: a click that crosses a tile edge is still a click
      const inSelRoom = !!selectedRoomId && station.roomAt(w.tx, w.ty) === selectedRoomId;
      // Shift over a BELT inside the selected room grabs the ROOM (a hallway its belt covers end to end has no bare floor to press —
      // the retired MOVE tool skipped belts the same way); a plain press on a belt keeps its own card / branch
      if (inSelRoom && ev.shiftKey && station.beltAt(w.tx, w.ty)) { drag = { mode: 'roompress', roomId: selectedRoomId, start: w, cur: w, moved: false, cx: ev.clientX, cy: ev.clientY, viaBelt: true }; return; }
      /* Ctrl+drag a belt RESHAPES it (wave 2, build-16): a PRESS first, like a belt press — a Ctrl+click (or one that drifts a pixel
         across a tile edge) opens the belt's card and commits nothing; only a drag past CLICK_SLOP reshapes. A tile no link rides (a
         loose or legacy belt) falls through to the belt card, which says what it is; a tile two links share says how to pick one */
      if(station.beltAt(w.tx,w.ty) && (ev.ctrlKey || ev.metaKey)) {
        const matches=linksMemoed().filter(l=>(l.path||[]).some(q=>q.x===w.tx&&q.y===w.ty));
        if(matches.length>1){sfx('bad');flashTip(ev,'THIS TILE CARRIES '+matches.length+' BELTS — CTRL+DRAG A TILE ONLY ONE BELT RIDES TO RESHAPE IT',false);return;}
        if(matches.length===1){drag={mode:'reshapepress',linkId:matches[0].id,from:{x:w.tx,y:w.ty},start:w,cur:w,moved:false,cx:ev.clientX,cy:ev.clientY};return;}
      }
      // a BELT: a click opens its card on the release, a drag off it BRANCHES it (a SPLITTER lands where it was pressed)
      if (station.beltAt(w.tx, w.ty)) { drag = { mode: 'beltpress', start: w, cur: w, moved: false, from: { x: w.tx, y: w.ty }, cx: ev.clientX, cy: ev.clientY }; return; }
      // inside the SELECTED ROOM, on bare floor: a drag moves the room and everything on it rides along (what the MOVE tool did)
      if (inSelRoom) { drag = { mode: 'roompress', roomId: selectedRoomId, start: w, cur: w, moved: false, cx: ev.clientX, cy: ev.clientY }; return; }
      // ...and a ROOM opens its own sheet — on the RELEASE now, so the same press can become a box. Clicking the thing
      // you spent build mode MAKING used to be the one dead click in the editor.
      drag = { mode: 'boxpress', start: w, cur: w, moved: false, add: ev.shiftKey, roomId: station.roomAt(w.tx, w.ty) };
      return;
    }
    if (tool === 'belt') {
      /* CONNECT MODE — the primary belt interaction (2026-07-05 UX reshape): click one MACHINE, then
         another, and the path lays itself (station.connectBelt — oriented, hooked, junction-aware).
         Clicking empty floor still starts the classic hand-laid drag; a second click on the same
         machine (or any empty click mid-connect) cancels. */
      const pid = propAtEvent(ev);
      const pp = pid && station.propById(pid);
      if (pp && CONNECT_TYPES[pp.t]) {
        /* JOIN A LINE armed this BAY as the destination: the click names the machine that hands it work. A refusal (an OUTBOX,
           no route) keeps it armed so the next click can try another machine; the BAY itself, or empty floor, cancels. */
        if (connectTo) {
          if (pid === connectTo) { connectTo = null; hideTip(); return; }
          const res = station.connectBelt(pid, connectTo);
          if (res && res.ok) {
            connectTo = null; sfx('chime'); flashTip(ev, 'CONNECTED — ' + res.count + ' belts laid themselves · the BAY is on that line now', true);
            if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();
          } else { sfx('bad'); flashTip(ev, (res && res.msg) || 'no clear route between those machines', false); }
          return;
        }
        if (!connectFrom) {
          // an OUTBOX ends its line: it is never where a belt starts (worldmodel HANDOFF_WORDS) — said on the first click, not the second
          const no = station.connectRefusal ? station.connectRefusal(pid, null) : null;
          if (no) { sfx('bad'); flashTip(ev, no.msg, false); return; }
          // (an OUTBOX arms a SEND TO: its one destination is another line's INBOX — never a belt)
          connectFrom = pid; sfx('click'); flashTip(ev, pp.t === 'outbox' ? 'SEND TO — now click another line’s INBOX: each job that finishes cleanly here starts a job on it' : 'FROM ▸ ' + (propSpec(pp.t).label || pp.t).toUpperCase() + ' — now click a destination', true); return;
        }
        if (connectFrom === pid) { connectFrom = null; hideTip(); return; }
        // the armed OUTBOX's second click on an INBOX: SEND TO (refused in its own words — this same line, a circle)
        const fo = station.propById(connectFrom);
        if (fo && fo.t === 'outbox' && pp.t === 'intake') { connectFrom = null; commitSendTo(fo.id, pid, ev); return; }
        const res = station.connectBelt(connectFrom, pid);
        connectFrom = null;
        if (res && res.ok) {
          sfx('chime'); flashTip(ev, 'CONNECTED — ' + res.count + ' belts laid themselves', true);
          if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();
        } else { sfx('bad'); flashTip(ev, (res && res.msg) || 'no clear route between those machines', false); }
        return;
      }
      if (connectFrom || connectTo) { connectFrom = null; connectTo = null; flashTip(ev, 'connect cancelled', false); return; }
      drag = { mode: 'beltrun', start: w, cur: w, moved: false };
    } else if (tool === 'prop') {
      drag = { mode: 'propstamp', start: w, cur: w, moved: false, cx: ev.clientX, cy: ev.clientY };   // cx/cy: a jitter is not a row
    } else if (tool === 'dupe') {
      // click-only tool: first click COPIES what's under the cursor, every later click STAMPS a copy.
      // CLICK-ON-MACHINE WINS: with a copy armed, a click ON an existing machine inspects it instead
      // of silently attempting an invalid stamp on top of it.
      if (dupe) {
        // (a CLIP in hand is the exception: its ghost is centred on the pointer, even over a machine, and says what the click does
        //  there — lays it, lays it out to fit nearby once the layout engine said so, or why not; Esc / right-click puts it down)
        const pid = station.propAt(w.tx, w.ty), p = pid && station.propById(pid);
        if (p && dupe.type !== 'lines') { onInspect(p, ev); return; }
        stampDupe(w, ev);
      } else pickupDupe(w, ev);
      return;
    } else if (tool === 'line') {
      // click-only tool: the armed starter line stamps under the cursor (the ghost already showed it).
      // CLICK-ON-MACHINE WINS: a click ON an existing machine inspects it — stamping only on clear deck.
      const pid = station.propAt(w.tx, w.ty), p = pid && station.propById(pid);
      if (p) { onInspect(p, ev); return; }
      stampLine(w, ev);
      return;
    } else if (tool === 'paint') {
      const id = station.roomAt(w.tx, w.ty);
      if (!id) { flashTip(ev, 'nothing to paint here'); return; }
      drag = { mode: 'paint', roomId: id, start: w, cur: w, cells: new Set([w.tx + ',' + w.ty]), moved: false };
    } else if (tool === 'reclaim') {
      drag = { mode: 'reclaim', start: w, cur: w, cells: new Set([w.tx + ',' + w.ty]), moved: false };
    } else { // room | hall
      drag = { mode: 'draw', start: w, cur: w, moved: false };
    }
  }

  const CLICK_SLOP = 12;   // screen px a press travels before it is a drag (the propstamp row's own rule: a jitter is not a row)
  function onMove(ev) {
    if (ev.pointerType === 'touch' && touchPts.has(ev.pointerId)) {
      touchPts.set(ev.pointerId, toCanvas(ev));
      if (drag && drag.mode === 'pinch' && touchPts.size >= 2) { const m = touchPair(); zoom = clamp(drag.z0*m.d/drag.d0, MINZ, MAXZ); panX = m.x-drag.wx*zoom; panY = m.y-drag.wy*zoom; return; }
      if (pinchLock) return;
    }
    if (dragPid != null && ev.pointerId !== dragPid) return;
    lastClient = { x: ev.clientX, y: ev.clientY };
    if (drag && drag.mode === 'pan') {
      const c = toCanvas(ev);
      panX += c.x - drag.sx; panY += c.y - drag.sy; drag.sx = c.x; drag.sy = c.y;
      return;
    }
    const w = toWorldTile(ev);
    if (drag) {
      drag.forceMove = !!ev.shiftKey;
      if (w.tx !== drag.cur.tx || w.ty !== drag.cur.ty) { drag.moved = true; snapTick(drag.mode); }
      // THE HAND: an UNSELECTED workflow machine dragged (Shift up) lays a belt to the pointer; a SELECTED one moves over open floor
      // and lays the belt over another machine (the target decides); Shift, or any other prop, moves (SELECT MOVES, 10-11); the
      // selected ROOM's floor dragged moves the room.
      // A press becomes a gesture only once the pointer has travelled CLICK_SLOP screen px (repair 2026-10-11): a click or a tap
      // that drifts a pixel or two across a tile edge (a 2x2 BAY's middle seam, a belt's next tile, a machine's rim — common on
      // touch and zoomed out) stays a click — it never turns into a refused belt, THE SAME BELT or a PICK WHAT GOES HERE.
      const slipped = drag.cx == null || Math.hypot(ev.clientX - drag.cx, ev.clientY - drag.cy) >= CLICK_SLOP;
      if(drag.mode==='selectpress'&&drag.moved&&slipped)drag.mode=(!drag.add&&!drag.sel&&beltSource(drag.propId))?'handbelt':'propmove';
      /* ONE GESTURE, THE TARGET DECIDES (SELECT MOVES refine, 10-11 — make what people already try work): a SELECTED conveyor
         machine dragged onto ANOTHER conveyor machine (or a belt the hand would merge into) is THE HAND's belt / SEND TO — its
         ghost, its verdict, its commit — exactly as if it had not been selected; over open floor it stays a MOVE. Asked tile by
         tile (selectedDragAims), so the ghost always says what letting go there does. Shift held = a move, always. */
      if (drag.sel && !drag.add && (drag.mode === 'propmove' || drag.mode === 'handbelt')) drag.mode = selectedDragAims(drag, w, ev.shiftKey) ? 'handbelt' : 'propmove';
      if (HAND_PLAN_MODES[drag.mode]) drag.handSeen = true;   // (it was a belt drag at some point: R's flip belongs to it — upCommit / releaseDrag use it up)
      if(drag.mode==='roompress'&&drag.moved&&slipped)drag.mode='move';
      if ((drag.mode === 'propmove' || drag.mode === 'groupmove' || drag.mode === 'move') && cv.style.cursor !== 'move') cv.style.cursor = 'move';   // a move carries the move cursor (onUp restores)
      if(drag.mode==='beltpress'&&drag.moved&&slipped)drag.mode='handbranch';
      if(drag.mode==='reshapepress'&&drag.moved&&slipped)drag.mode='beltreshape';   // (a Ctrl+press becomes a reshape only past the slop)
      if ((drag.mode === 'handbelt' || drag.mode === 'handbranch') && cv.style.cursor !== 'crosshair') cv.style.cursor = 'crosshair';   // laying a belt aims (onUp restores)
      if(drag.mode==='grouppress'&&drag.moved&&slipped)drag.mode='groupmove';   // (a click on one member never moves the line one tile: wave 2, build-20)
      if(drag.mode==='boxpress'&&drag.moved)drag.mode='box';
      if (drag.mode === 'paint' || drag.mode === 'reclaim') rasterTo(drag, w);   // accumulate every tile the brush crosses
      drag.cur = w;
    } else {
      if (selectedRoomId && tool === 'select') {
        const hh = roomHandleAt(ev); hoverHandle = hh ? hh.i : -1;
        if (hh) cv.style.cursor = hh.cur; else if (/resize$/.test(cv.style.cursor || '')) setCursor();
      } else hoverHandle = -1;
      hoverPropId = propAtEvent(ev);
      hoverRoomId = station.roomAt(w.tx, w.ty);
      hoverTile = { tx: w.tx, ty: w.ty };
      // the pointer says what a drag here would do: move (a selected piece, the selected room's floor, Shift) or lay a belt
      // (an armed tool asks too: its selected piece wears the move cursor where a drag on it moves it — pressMovesSelection)
      if (hoverHandle < 0) { const want = cursorFor(ev.shiftKey); if (cv.style.cursor !== want) cv.style.cursor = want; }
      // hovering a placed FUNCTIONAL prop shows its Fallout-style card (what it does + its live assignment)
      const hp = hoverPropId && station.propById(hoverPropId);
      const sp = hp && (typeof PropSprites !== 'undefined') && PropSprites.spec(hp.t);
      if (sp && sp.tier === 'functional') showPropCard(sp, hp, ev.clientX, ev.clientY);
      else hidePropCard();
    }
  }

  function onUp(ev) {
    if (ev.pointerType === 'touch') {
      touchPts.delete(ev.pointerId);
      if (pinchLock) { try { cv.releasePointerCapture(ev.pointerId); } catch (_) {} if (touchPts.size < 2) drag = null; if (!touchPts.size) pinchLock = false; return; }
    }
    if (dragPid != null && ev.pointerId !== dragPid) return;
    try { cv.releasePointerCapture(ev.pointerId); } catch (e) {}
    dragPid = null;
    if (!drag) return;
    const d = drag; drag = null;
    setCursor();
    upCommit(d, ev);
    // ...and AGAIN once the release has done its work: a click that just SELECTED the machine under the pointer turns its belt
    // crosshair into the move cursor (a drag from it moves it now), a Shift+click that dropped it turns it back
    if (!drag) setCursor();
  }
  function upCommit(d, ev) {
    if (d.mode === 'pan' || d.mode === 'pinch') return;
    // a SELECTED piece's belt drag that turned back into a MOVE before the release (the target decides, tile by tile) used R's flip
    // too: the MOVE's commit never reset it, so CORNER stayed lit and the next belt drag turned the flipped way (wave 2 repair, build-10)
    if (d.handSeen && !HAND_PLAN_MODES[d.mode] && flipPref) { flipPref = false; handPvKey = ''; paintHandKeys(); }
    if (d.mode === 'selectpress' || d.mode === 'grouppress') return d.add ? toggleInSelection(d.propId) : onInspect(station.propById(d.propId),ev);
    if (d.mode === 'beltpress') return openBeltCard(d.start.tx, d.start.ty, ev);   // a belt CLICKED (not dragged): where it goes
    if (d.mode === 'reshapepress') return openBeltCard(d.start.tx,d.start.ty,ev);   // a Ctrl+CLICK on a belt: its card, nothing reshaped
    if (HAND_PLAN_MODES[d.mode]) return commitHandGesture(d, ev);
    if (d.mode === 'groupmove') return commitGroupMove(d, ev);
    if (d.mode === 'roompress' && d.viaBelt) return openBeltCard(d.start.tx, d.start.ty, ev);   // a Shift+CLICK on its belt still opens the belt's card
    if (d.mode === 'boxpress' || d.mode === 'roompress') return clickEmptyFloor(d, ev);
    if (d.mode === 'box') return commitBox(d, ev);
    if (d.mode === 'roomresize') return commitRoomResize(d, ev);
    if (d.mode === 'draw') return commitDraw(d, ev);
    if (d.mode === 'move') return commitMove(d, ev);
    if (d.mode === 'propmove') return commitPropMove(d, ev);
    if (d.mode === 'propstamp') return commitPropStamp(d, ev);
    if (d.mode === 'beltrun') return commitBeltRun(d, ev);
    if (d.mode === 'paint') return commitPaint(d, ev);
    if (d.mode === 'reclaim') return commitReclaim(d, ev);
  }
  function onCancel() { touchPts.clear(); pinchLock = false; clearTimeout(inspectTimer); if (drag || dragPid != null) { releaseDrag(); hideTip(); setCursor(); } }
  /* ALT-TAB DROPS THE WHOLE GESTURE, not just a pan. This cancelled `pan` only, so tabbing away mid
     draw/belt/paint left a live drag with a frozen ghost pinned to the last tile the pointer touched —
     and the pointer that would have ended it is now somewhere else entirely. A gesture you cannot see
     is a gesture you cannot finish: end it, release the capture, and let the floor go quiet. */
  function onBlur() { touchPts.clear(); pinchLock = false; clearTimeout(inspectTimer); spaceHeld = false; altHeld = false; if (drag || dragPid != null) { releaseDrag(); hideTip(); } setCursor(); }   // (Alt+Tab never leaves the Alt view stuck on)

  // add every tile on the segment from drag.cur to w (so a fast brush stroke skips nothing)
  function rasterTo(d, w) {
    let x0 = d.cur.tx, y0 = d.cur.ty; const x1 = w.tx, y1 = w.ty;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, guard = 0;
    while (guard++ < 4096) {
      d.cells.add(x0 + ',' + y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  function commitDraw(d, ev) {
    // CLICK-ON-MACHINE WINS: a plain click (no drag) on an existing machine inspects it — a 1×1
    // room/hall attempt on top of a prop was never anything but a red flash.
    if (!d.moved) {
      const exist = station.propAt(d.cur.tx, d.cur.ty);
      const ep = exist && station.propById(exist);
      if (ep) { onInspect(ep, ev); return; }
    }
    /* a click stamps the remembered size (what the hover ghost was showing); a drag draws its own.
       Both go through the SAME snapFit the ghost drew — commit what was on screen, never the raw
       gesture, or the snap becomes a lie the instant you press. `rememberDrawn` reads the SNAPPED
       rect too, so a room that grew a tile to meet its neighbour teaches the next click that size. */
    // capture the armed tool BEFORE the success path disarms it — deselectTool resets `tool` to
    // 'select', so reading it again in the feedback line called every hallway a "room placed"
    const isHall = tool === 'hall';
    const rect = !d.moved ? snapFit(stampRectFor(d.cur.tx, d.cur.ty), {})
      : snapFit(isHall ? laneRect(d.start, d.cur) : norm(d.start, d.cur), { resize: true });
    const res = isHall ? station.placeHallway({ rect }) : station.addRoom({ kind, rect });
    if (res && res.ok) {
      pushFlash([rect], false);
      rememberDrawn(rect);
      deselectTool({ silent: true });
    }
    feedback(res, ev, isHall ? 'hallway run' : 'room placed');
  }
  function commitMove(d, ev) {
    // the SAME snapped delta the move ghost drew — commit what was on screen, never the raw drag
    const rm = station.roomById(d.roomId);
    const s = snapMoveDelta(rm, d.cur.tx - d.start.tx, d.cur.ty - d.start.ty);
    if (!s.dx && !s.dy) { hideTip(); return; }
    feedback(keepsHalls(() => station.moveRoom(d.roomId, s.dx, s.dy)), ev, 'relocated');
  }
  function propSpec(id) { return (typeof PropSprites !== 'undefined' && PropSprites.spec(id)) || { w: 1, h: 1 }; }
  /* ---------- PROP ORIENTATION (R / shift+R turn · M flip) ----------
     `propRot`/`propMir` are the PENDING orientation the next stamp carries. Both are asked of
     PropSprites first: a prop only offers a turn where its art is genuinely DRAWN turned, and only
     offers a flip where the light correction can reach it — R on a prop with one authored facing
     does nothing and says why, rather than stamping a footprint the picture does not fill. */
  let propRot = 0, propMir = 0;
  const PS = () => (typeof PropSprites !== 'undefined' ? PropSprites : null);
  const canTurn = t => { const P = PS(); return !!(P && P.canRotate && P.canRotate(t)); };
  const canFlip = t => { const P = PS(); return !!(P && P.canMirror && P.canMirror(t)); };
  // New placements use the catalog box. A placed prop keeps its saved size:
  // the renderer's before/after boxes decide only whether that actual footprint
  // turns. This prevents a compact saved desk growing to the current catalog size.
  function propBox(t, r, placed) {
    const P = PS(), s = propSpec(t);
    const b = (P && P.footprintAt && P.footprintAt(t, r | 0)) || { w: s.w || 1, h: s.h || 1 };
    if (!placed) return b;
    const before = P && P.footprintAt && P.footprintAt(t, placed.r | 0);
    // A square catalog decal hides its turn in equal dimensions, but a saved
    // rectangular variant still needs to rotate its actual floor plan.
    const plan = s.flat || s.surface || (P && P.PLAN_FOOTPRINT && P.PLAN_FOOTPRINT.includes(t));
    const squarePlan = before && before.w === before.h && plan && (((placed.r | 0) ^ (r | 0)) & 1);
    const swaps = squarePlan || (before && before.w !== before.h && b.w === before.h && b.h === before.w);
    return swaps ? { w: placed.h, h: placed.w } : { w: placed.w, h: placed.h };
  }
  const nextFace = (t, r, dir) => { const P = PS(); return (P && P.nextFacing) ? P.nextFacing(t, r, dir) : ((r + dir) & 3); };
  const propFacing = t => (canTurn(t) ? (propRot & 3) : 0);   // pending rot, clamped to what the art can do
  const propFlipOn = t => (canFlip(t) ? (propMir ? 1 : 0) : 0);
  // r counts quarter turns CLOCKWISE from the shipped south-facing art (worldmodel + PropAnchor agree)
  const FACE_WORD = ['south', 'west', 'north', 'east'];
  // keyboard events carry no cursor position; the tip anchors to the last place the pointer was.
  const orientEv = () => ({ clientX: lastClient.x, clientY: lastClient.y });
  // Placement owns R/M. Browsing may rotate the hovered furniture; placing never edits it.
  const orientTarget = () => (tool === 'select' && !hand && !drag && (hoverPropId || selectedPropId)) ? station.propById(hoverPropId || selectedPropId) : null;
  const propLabel = t => String(propSpec(t).label || t).toUpperCase();

  function turnUnderCursor(dir) {
    const ev = orientEv(), p = orientTarget();
    if (p) {
      if (!canTurn(p.t)) { sfx('bad'); flashTip(ev, propLabel(p.t) + (/^user_/.test(p.t) ? ' has no side view yet \u00b7 select it and pick SIDE VIEW (about 30\u00a2) to turn it' : ' only faces one way — its turned art is not drawn')); return; }
      const nr = nextFace(p.t, p.r | 0, dir);
      const res = station.faceProp(p.id, nr, propBox(p.t, nr, p));
      if (res && res.ok) pushFlash([{ x1: p.x, y1: p.y, x2: p.x + p.w - 1, y2: p.y + p.h - 1 }], false);   // p is mutated in place → the NEW box
      feedback(res, ev, 'turned · facing ' + FACE_WORD[(p.r | 0) & 3]);
      return;
    }
    if (!placingProp()) { sfx('bad'); flashTip(ev, 'hover a placed prop to turn it, or pick one from the Props tab'); return; }
    if (!canTurn(propType)) { sfx('bad'); flashTip(ev, propLabel(propType) + (/^user_/.test(propType) ? ' has no side view yet \u00b7 MAKE SIDE VIEW (about 30\u00a2) turns it' : ' only faces one way — its turned art is not drawn')); return; }
    propRot = nextFace(propType, propRot, dir) & 3;
    renderPropPreview();
    renderEquipmentInfo();
    const b = propBox(propType, propRot);
    sfx('click'); flashTip(ev, 'facing ' + FACE_WORD[propRot] + ' · ' + b.w + '×' + b.h, true); setHint();
  }

  function flipUnderCursor() {
    const ev = orientEv(), p = orientTarget();
    if (p) {
      if (!canFlip(p.t)) { sfx('bad'); flashTip(ev, propLabel(p.t) + ' cannot be flipped — its light is painted in, not derived'); return; }
      const res = station.mirrorProp(p.id);
      if (res && res.ok) pushFlash([{ x1: p.x, y1: p.y, x2: p.x + p.w - 1, y2: p.y + p.h - 1 }], false);
      feedback(res, ev, (res && res.m) ? 'flipped' : 'unflipped');
      return;
    }
    if (!placingProp()) { sfx('bad'); flashTip(ev, 'hover a placed prop to flip it, or pick one from the Props tab'); return; }
    if (!canFlip(propType)) { sfx('bad'); flashTip(ev, propLabel(propType) + ' cannot be flipped — its light is painted in, not derived'); return; }
    propMir = propMir ? 0 : 1;
    renderPropPreview();
    renderEquipmentInfo();
    sfx('click'); flashTip(ev, propMir ? 'flipped' : 'unflipped', true); setHint();
  }
  // open the right editor for a logistics prop that carries config (BAY = agent, FILTER/MERGER = routing, AIRLOCK = seal)
  // a workstation (PC/desk) opens the dedicated WORKSTATION picker; bays/junctions/etc. keep their editors.
  // (Trunk's PC-binding via the BAY picker is unified into the workstation picker — same agentId field, richer UX.)
  // a MERGER has no config (pure topology, like the splitter) — it explains itself via the flow card.
  /* THE INSPECT SEAM (2026-08-05): every "the user clicked a machine to look at it" path lands on
     this ONE dispatch point — select-mode clicks, click-on-machine-wins from armed tools, freshly
     placed configurables, and the openAssign deep link. The follow-up per-dock step editor replaces
     the routing INSIDE this function; callers never fan out on prop type themselves. */
  function onInspect(p,ev) {
    if(!p)return;
    // THE HAND part 2: a double-TAP on a conveyor piece takes its whole line (a mouse's double-click is onDblClick)
    if(ev&&ev.pointerType==='touch'&&CONNECT_TYPES[p.t]&&tool==='select'){const tNow=performance.now();if(lastTap&&lastTap.id===p.id&&tNow-lastTap.t<380){lastTap=null;clearTimeout(inspectTimer);selectWholeLine(p.id,ev);return;}lastTap={id:p.id,t:tNow};}
    clearTimeout(inspectTimer);
    if(ev&&ev.detail>=2&&CONNECT_TYPES[p.t]){selectWholeLine((clickMachine&&clickMachine.id)||p.id,ev);return;}
    clickMachine={id:p.id,t:performance.now(),x:ev&&ev.clientX,y:ev&&ev.clientY};   // (where it was clicked: a double-click elsewhere is not on it)
    selBelts=null;groupIds=[];selectedRoomId=null;selectedPropId=p.id;renderSelection();
    // an UNBOUND connector/plugin terminal says "CLICK TO BIND" on the floor and in its hover card — so one click
    // opens the bind editor (it only selected it, and members reported "no bind option": only unbind/cancel showed)
    if((p.t==='connector_portal'&&!p.connectorId)||(p.t==='plugin_terminal'&&!p.pluginId))return configureProp(p,ev);
    // a SIGN is nothing but its words: one click opens the editor (the board is the label, the
    // label is the board — there is no other setting to show first)
    if(isSignProp(p.t))return openSignEditor(p.id,ev);
    // THE CARD AND THE FLOOR ARE ONE LINE: a click on a line machine opens the docked Workflow panel on it
    // (or re-selects it there), without panning — the floor is where the Commander is looking
    if(WF_PART[p.t]){const id=p.id;inspectTimer=setTimeout(()=>{if(running&&selectedPropId===id&&!pinchLock){finFocusLine(id);openWorkflowPanel(id,true);}},400);}
    setHint('Selected '+propLabel(p.t)+' · '+dragWords(p)+' · choose an action in the build kit');
  }
  // what a drag on the SELECTED piece does, in words (ONE GESTURE, THE TARGET DECIDES — a conveyor machine belts onto a machine)
  const dragWords = p => CONNECT_TYPES[p.t] ? 'drag it onto another machine to belt them, onto open floor to move it' : 'drag it to move it';
  /* THE SELECTED OBJECT, BESIDE THE LIBRARY (2026-10-01 build-mode upgrade). Selecting a placed prop used to REPLACE the whole Build
     Library with a column of keys, so placing the next thing meant deselecting first. It is now one compact card ABOVE the library —
     the object's own art and name, then its actions, each key wearing the keyboard shortcut that does the same thing (drag, R, M,
     Ctrl+D, Ctrl+C, Delete, the arrows nudge) — and the library stays where it was. */
  function renderSelection(){
    const host=root&&root.querySelector('#refit-selection');if(!host)return;
    if(dropPick){host.hidden=false;root.classList.add('has-selection');return renderDropPick(host);}   // THE HAND: PICK WHAT GOES HERE docks where a selection does
    if(groupIds.length){
      const ps=groupIds.map(id=>station&&station.propById(id)).filter(Boolean);
      if(ps.length>1){host.hidden=false;root.classList.add('has-selection');return renderGroupCard(host,ps);}
      groupIds=[];if(ps.length===1)selectedPropId=ps[0].id;   // an undo took the rest away: one is just a selection
    }
    // THE HAND part 2: a selection that took BELTS (a box across them, a whole line) is a group card even with one machine or none
    if(selBelts&&!selectedRoomId){const bs=beltSel();if(bs){host.hidden=false;root.classList.add('has-selection');return renderGroupCard(host,selectionIds().map(id=>station.propById(id)).filter(Boolean));}}
    if(selectedRoomId){
      const rm=station&&station.roomById(selectedRoomId);
      if(rm){host.hidden=false;root.classList.add('has-selection');return renderRoomCard(host,rm);}
      selectedRoomId=null;   // an undo took the room away
    }
    const p=station&&station.propById(selectedPropId);host.hidden=!p;root.classList.toggle('has-selection',!!p);
    if(!p){host.replaceChildren();return;}
    host.innerHTML='<div class="refit-sel-head"><span class="refit-sel-art" aria-hidden="true"></span><span class="refit-sel-name"><b>'+esc(propLabel(p.t))+'</b><small>'+p.w+' × '+p.h+' tiles'+(canTurn(p.t)?' · facing '+FACE_WORD[(p.r|0)&3]:'')+(pressMovesSelection()?' · '+(CONNECT_TYPES[p.t]?'drag onto floor to move, onto a machine to belt':'drag it to move')+' · arrows nudge':'')+'</small></span>'
      +'<button class="bb sm refit-sel-x" type="button" aria-label="Deselect" data-tip="Deselect · Esc">\u2715</button></div><div class="refit-selection-actions"></div>';
    propArtInto(host.querySelector('.refit-sel-art'),p);
    host.querySelector('.refit-sel-x').onclick=()=>{selectedPropId=null;renderSelection();setHint();sfx('click');};
    const actions=host.querySelector('.refit-selection-actions');
    if(WORKSTATION_TYPES[p.t])actions.before(sitsRow(p));   // the desk's agent is picked RIGHT HERE, one click (no CONFIGURE, no modal)
    const addKey=(label,key,fn,cls)=>{const b=document.createElement('button');b.className='bb sm refit-sel-act'+(cls?' '+cls:'');b.type='button';b.innerHTML='<span>'+esc(label)+'</span>'+(key?'<kbd>'+esc(key)+'</kbd>':'');b.onclick=fn;actions.appendChild(b);return b;};
    const add=(label,fn)=>addKey(label,'',fn);
    // (no MOVE key — SELECT MOVES, 10-11: the selected piece moves when dragged; the sub-line above says so)
    if(canTurn(p.t))addKey('TURN','R',()=>{const nr=nextFace(p.t,p.r|0,1);feedback(station.faceProp(p.id,nr,propBox(p.t,nr,p)),orientEv(),'turned');renderSelection();});
    if(canFlip(p.t))addKey('FLIP','M',()=>{feedback(station.mirrorProp(p.id),orientEv(),'flipped');renderSelection();});
    addKey('DUPLICATE','Ctrl+D',()=>duplicateSelected(orientEv()));
    addKey('COPY','Ctrl+C',()=>copySelected(orientEv()));
    // a conveyor piece on a line: its WHOLE LINE in one press (what a double-click / double-tap does) — then COPY LINE / DELETE LINE
    if(CONNECT_TYPES[p.t]&&typeof station.lineMembers==='function'){const lm=station.lineMembers(p.id);if(lm&&lm.ids.length>1)addKey('WHOLE LINE','dbl-click',()=>selectWholeLine(p.id,orientEv()));}
    // a MADE prop carries its library controls right here: SIZE (free) and its side view, like the MAKE A PROP panel
    const made=(typeof UserProps!=='undefined'&&UserProps.get&&typeof PropSprites!=='undefined'&&PropSprites.isUserProp&&PropSprites.isUserProp(p.t))?UserProps.get(p.t):null;
    if(made){
      const k=UserProps.SCALES.includes(made.scale)?made.scale:1;
      if(k>UserProps.SCALES[0])add('SIZE \u2212',()=>sizeMadeProp(-1,p.t));
      if(k<UserProps.SCALES[UserProps.SCALES.length-1])add('SIZE + ('+Math.round(k*100)+'%)',()=>sizeMadeProp(1,p.t));
      if(!made.side&&!made.symmetric)add('\u21bb SIDE VIEW',async()=>{setHint('Starting a side view of '+(made.label||'this prop')+'\u2026');const r=await startMakeSide(p.t);if(!r)setHint('A prop job is already running \u00b7 wait for it to finish');else setHint(r.ok?'Making a side view of '+(made.label||'this prop')+' \u00b7 about $0.30 \u00b7 it turns with R when it lands':(r.message||'That side view could not be started.'));});
    }
    if(isEditableProp(p.t)&&!WORKSTATION_TYPES[p.t])add('CONFIGURE',()=>configureProp(p,orientEv()));
    if(isSignProp(p.t))add('WORDS',()=>openSignEditor(p.id,orientEv()));   // a SIGN's own text (sign editor)
    addKey('DELETE','Del',()=>deleteSelected(orientEv()),'refit-sel-del');
    // typing an exact tile: its own key in the grid (the arrows nudge; this is for "put it at 12, 4"), the fields only when asked
    addKey('POSITION','',()=>{positionOpen=!positionOpen;renderSelection();},'refit-sel-pos').setAttribute('aria-expanded',String(positionOpen));
    if(!positionOpen)return;
    const position=document.createElement('div');position.className='refit-position';
    position.innerHTML='<label>X <input aria-label="Object grid X" type="number" step="1" value="'+p.x+'"></label><label>Y <input aria-label="Object grid Y" type="number" step="1" value="'+p.y+'"></label><button class="bb sm" type="button">APPLY POSITION</button>';
    position.querySelector('button').onclick=()=>{
      const inputs=position.querySelectorAll('input'),x=Number(inputs[0].value),y=Number(inputs[1].value);
      if(!Number.isInteger(x)||!Number.isInteger(y)){feedback({ok:false,msg:'Use whole tile coordinates'},orientEv());return;}
      const res=station.moveProp(p.id,x-p.x,y-p.y);feedback(res,orientEv(),moveMsg(res,0,'position updated'));renderSelection();
    };host.append(position);
  }
  /* ---------- THE EDITOR KEYS (2026-10-01 build-mode upgrade) ----------
     What every editor does, on the SELECTED object: Delete/Backspace removes it, Ctrl+D drops a copy beside it (the copy is then
     the selection, so Ctrl+D again makes a row), Ctrl+C picks it up as a stamp (every click places a copy; Ctrl+V picks the last one
     up again), the arrows nudge it a tile (Shift: five). Each is one ordinary edit — one UNDO. A lone prop's copy is the COPY tool's
     own pickup: orientation, a filter's routes, a door's seal travel with it; an agent binding never does. A conveyor piece, a group
     or a line copies as a CLIP (THE HAND part 2) — the belts between its machines, settings, names, briefs and the crew this station has. */
  function copySpecOf(p) {
    const s = propSpec(p.t), cfg = {};
    if (p.r) cfg.r = p.r;
    if (p.m) cfg.m = 1;
    if (p.routes && typeof p.routes === 'object') cfg.routes = Object.assign({}, p.routes);
    if (p.def) cfg.def = p.def;
    if (p.door) cfg.door = p.door;
    if (p.text) cfg.text = p.text;   // a SIGN's words belong to the copy, not to the shelf
    return { t: p.t, w: p.w || 1, h: p.h || 1, block: s.blocks !== false, cfg };
  }
  // the nearest clear spot for a copy: right of it, below, left, above — then ring by ring outward
  function freeSpotNear(spec, x0, y0) {
    const fits = (x, y) => !!(station.canPlaceProp(spec.t, x, y, spec.w, spec.h) || {}).ok;
    for (const [dx, dy] of [[spec.w, 0], [0, spec.h], [-spec.w, 0], [0, -spec.h]]) if (fits(x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
    for (let r = 1; r <= 10; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (fits(x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
    }
    return null;
  }
  /* the SEND TO cut warning's arm: { key, t, room } — `room` = the room a room delete warned for (doDeleteRoom), so only THAT
     room's repeat DELETE gets the warning's 6 s window (repair: an old, unconfirmed warning stretched every later room's 2.5 s
     confirm to 6 s); a new selection lets it go (selectRoom) */
  let sendCutArm = null;
  const cutArmFor = roomId => !!(sendCutArm && roomId != null && sendCutArm.room === roomId && performance.now() - sendCutArm.t < 6000);
  /* `again` = the gesture that armed the warning, said in it and part of its arm key: the confirm is THAT gesture repeated (wave 2,
     build-15 — "repeat DELETE / REMOVE" told a Ctrl+X or right-click user to repeat a key they never pressed, in mixed case) */
  function warnSendCuts(ids, ev, roomId, again) {
    const gone = new Set(ids), cuts = station.props().filter(p => p.t==='outbox' && p.sendTo && gone.has(p.sendTo) && !gone.has(p.id));
    if (!cuts.length) { sendCutArm=null; return false; }
    const verb = String(again || 'DELETE').toUpperCase();
    const key = verb+'|'+ids.slice().sort().join(',')+'|'+cuts.map(p=>p.id+':'+p.sendTo).sort().join(',');
    if (sendCutArm && sendCutArm.key===key && performance.now()-sendCutArm.t<6000) { sendCutArm=null; return false; }
    sendCutArm={key,t:performance.now(),room:roomId==null?null:roomId};
    const names=cuts.map(p=>(station.lineNameAt&&station.lineNameAt(p.id))||'A LINE');   // (the one line name: worldmodel.lineName)
    sfx('tick'); flashTip(ev,('THIS CUTS '+cuts.length+' SEND TO'+(cuts.length===1?'':'S')+' FROM '+Array.from(new Set(names)).join(', ')+' — '+verb+' AGAIN TO CONTINUE · UNDO RESTORES THEM').toUpperCase(),false); return true;
  }
  function deleteSelected(ev) {
    if (groupIds.length) return deleteGroupOrLine(ev);
    if (beltSel()) return deleteGroup(ev);   // (THE HAND part 2: the belts it took go too)
    const p = station.propById(selectedPropId); if (!p) return false;
    if (warnSendCuts([p.id],ev)) return false;
    const had = linkedFloor() && isWorkflowType(p.t) && (station.links() || []).some(l => l.from.prop === p.id || l.to.prop === p.id);
    const was = Object.assign({}, p);
    const res = station.removeProp(p.id);
    if (res && res.ok) { pushFlash([{ x1: was.x, y1: was.y, x2: was.x + was.w - 1, y2: was.y + was.h - 1 }], true); vanishProp(was); }
    feedback(res, ev, had ? 'removed · its belts stay, loose — nothing rides them until a machine stands where they end · Undo restores it' : 'removed · Undo restores it');
    if (res && res.ok) { selectedPropId = null; renderSelection(); setHint(); }
    return true;
  }
  function duplicateSelected(ev) {
    if (groupIds.length) return duplicateGroup(ev);
    if (beltSel() || clipWorthy()) return duplicateClip(ev);   // (THE HAND part 2: a conveyor piece comes with its crew, brief and settings)
    const p = station.propById(selectedPropId); if (!p) return false;
    const spec = copySpecOf(p), at = freeSpotNear(spec, p.x, p.y);
    if (!at) { sfx('bad'); flashTip(ev, 'no clear floor beside it for a copy — clear some space, or COPY it to place one anywhere'); return true; }
    const res = station.addProp(Object.assign({ t: spec.t, x: at.x, y: at.y, w: spec.w, h: spec.h, block: spec.block }, spec.cfg));
    if (res && res.ok) {
      pushFlash([{ x1: at.x, y1: at.y, x2: at.x + spec.w - 1, y2: at.y + spec.h - 1 }], false);
      landProps([res.id]);
      if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
      if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced(spec.t);
      if (res.id) { selectedPropId = res.id; renderSelection(); }
    }
    feedback(res, ev, 'duplicated · the copy is selected · Ctrl+D again for another');
    return true;
  }
  let lastCopy = null;   // the last thing picked up with Ctrl+C / COPY (a prop, a room, or a CLIP of floor) — Ctrl+V picks it up again
  /* COPY: a lone piece of furniture is the COPY tool's own pickup (a stamp, as it always was); a group, a conveyor piece or a
     selection with belts is a CLIP — the machines with the belts between them, settings, names, briefs and crew (THE HAND part 2) */
  function copySelected(ev) {
    if (groupIds.length || beltSel() || clipWorthy()) return copyClip(ev, false);
    const p = station.propById(selectedPropId); if (!p) return false;
    selectTool('dupe', { keepGroup: true, silent: true });
    pickupDupe({ tx: p.x, ty: p.y }, ev, p.id);
    return true;
  }
  function nudgeSelected(dx, dy, ev) {
    if (groupIds.length) return nudgeGroup(dx, dy, ev);
    const p = station.propById(selectedPropId); if (!p) return false;
    const res = station.moveProp(p.id, dx, dy);
    if (res && res.ok) { snapTick('propmove'); pushMoves([{ from: { x1: p.x - dx, y1: p.y - dy, x2: p.x - dx + p.w - 1, y2: p.y - dy + p.h - 1 }, to: { x1: p.x, y1: p.y, x2: p.x + p.w - 1, y2: p.y + p.h - 1 } }]); renderSelection(); }
    else { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked — nothing moved'); }
    return true;
  }
  /* ---------- MANY AT ONCE (2026-10-01 build-mode upgrade) ----------
     In SELECT a drag across empty floor draws a box, and everything it touches is selected (Shift adds to what is already
     selected); Shift+click adds or drops one; Ctrl+A takes the whole floor. The group then moves — drag any of them, or the
     arrows — duplicates (Ctrl+D: the whole arrangement again, beside itself) or goes (Delete) as ONE edit: one UNDO, and
     all-or-nothing (station.transact puts back anything half-done). A plain click on empty floor lets go of a selection; with
     nothing selected it still opens that room's card. */
  const selectionIds = () => groupIds.length ? groupIds.slice() : (selectedPropId ? [selectedPropId] : []);
  function setSelection(ids, belts) {
    const live = [...new Set(ids)].filter(id => station.propById(id));
    groupIds = live.length > 1 ? live : [];
    selectedPropId = live.length === 1 ? live[0] : null;
    positionOpen = false; selectedRoomId = null;
    // the belts it took (a box across them, a whole line) ride with exactly THIS selection — any other selection lets them go
    selBelts = belts && ((belts.links && belts.links.length) || (belts.tiles && belts.tiles.length)) ? { key: live.join(','), links: (belts.links || []).slice(), tiles: (belts.tiles || []).slice() } : null;
    renderSelection();
    const bs = beltSel(), nb = bs ? bs.links.length + bs.tiles.length : 0;
    if (!live.length && nb) setHint(nb + (nb === 1 ? ' belt' : ' belts') + ' selected · Delete removes ' + (nb === 1 ? 'it' : 'them'));
    else if (live.length > 1 || (live.length && nb)) setHint(live.length + ' selected' + (nb ? ' with ' + nb + (nb === 1 ? ' belt' : ' belts') : '') + ' · drag any of them to move them together · Ctrl+C copies · Ctrl+D duplicates · Delete removes');
    else if (live.length === 1) setHint('Selected ' + propLabel(station.propById(live[0]).t) + ' · ' + dragWords(station.propById(live[0])) + ' · choose an action in the build kit');
    else setHint();
  }
  const propRect = (p, dx, dy) => ({ x1: p.x + (dx | 0), y1: p.y + (dy | 0), x2: p.x + (dx | 0) + (p.w || 1) - 1, y2: p.y + (dy | 0) + (p.h || 1) - 1 });
  const rectsMeet = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
  let boxMemo = null;
  function propsInBox(r) {
    const key = [geoVer, r.x1, r.y1, r.x2, r.y2].join('|');
    if (!boxMemo || boxMemo.key !== key) boxMemo = { key, ids: station.props().filter(p => rectsMeet(propRect(p), r)).map(p => p.id) };
    return boxMemo.ids;
  }
  function commitBox(d, ev) {
    const r = norm(d.start, d.cur), ids = propsInBox(r);
    const all = d.add ? selectionIds().concat(ids) : ids, bb = beltsInBox(r, all);
    if (!ids.length && !bb.n) { if (!d.add) setSelection([]); return; }   // an empty box lets go quietly — its badge already said what a box does
    sfx('click');
    const prev = d.add ? beltSel() : null;
    setSelection(all, { links: [...new Set((prev ? prev.links : []).concat(bb.links))], tiles: (prev ? prev.tiles : []).concat(bb.tiles) });   // (the belts it crossed come too)
  }
  // a plain click on empty floor: lets go of a selection; with nothing selected, a ROOM opens its own sheet (as it always has)
  function clickEmptyFloor(d, ev) {
    if (!d.add && selectionIds().length) { setSelection([]); sfx('click'); return; }
    if (d.roomId) { if (d.roomId !== selectedRoomId) openRoomCard(d.roomId, ev); return; }
    if (selectedRoomId) { selectRoom(null); sfx('click'); }
  }
  function toggleInSelection(id) {
    const ids = selectionIds(), i = ids.indexOf(id), bs = beltSel();
    if (i >= 0) ids.splice(i, 1); else ids.push(id);
    sfx('click'); setSelection(ids, bs);   // (Shift+click keeps the belts the box took)
  }
  function selectAllProps(ev) {
    const ids = station.props().map(p => p.id);
    if (!ids.length) { sfx('bad'); flashTip(ev, 'nothing on the floor to select yet'); return; }
    const onLink = new Set(); for (const l of linksMemoed()) for (const q of (l.path || [])) onLink.add(q.x + ',' + q.y);
    const junc = new Set(station.props().filter(p => JUNCTION_TAG_TYPES[p.t]).map(p => p.x + ',' + p.y));
    sfx('click'); setSelection(ids, { links: linksMemoed().map(l => l.id), tiles: beltsMemoed().filter(b => !onLink.has(b.x + ',' + b.y) && !junc.has(b.x + ',' + b.y)).map(b => ({ x: b.x, y: b.y })) });   // the whole floor — its belts too
  }
  /* move every member by (dx, dy) as ONE edit. Members go front-first along the motion, and one that would step into another's
     spot waits for it (pass after pass). Anything that cannot move — or a belt link that would be taken up on the way — puts
     the whole edit back: nothing is ever left half-moved. */
  function moveGroupBy(ids, dx, dy) {
    if (!dx && !dy) return { ok: true };
    // the model moves the group at once (a table under its own lamp, links re-laid after every member has moved)
    if (typeof station.moveProps === 'function') return station.moveProps(ids, dx, dy);
    const order = ids.map(id => station.propById(id)).filter(Boolean).sort((a, b) => (b.x * dx + b.y * dy) - (a.x * dx + a.y * dy)).map(p => p.id);
    return station.transact(() => {
      let pending = order, last = null;
      while (pending.length) {
        const next = [];
        for (const id of pending) {
          const r = station.moveProp(id, dx, dy);
          if (!r || !r.ok) { next.push(id); last = r; continue; }   // (a belt that cannot follow is moveProp's own LINK_LOST refusal)
        }
        if (next.length === pending.length) return last || { ok: false, msg: 'blocked — nothing moved' };
        pending = next;
      }
      return { ok: true };
    });
  }
  /* will the group fit at (dx, dy)? This only colours the drag ghost — moveGroupBy is the judge. Each member is asked of the
     floor, and its way counts as blocked only by something OUTSIDE the group: members step out of each other's way. */
  let groupFitMemo = null;
  function groupFit(ps, dx, dy) {
    const key = [geoVer, dx, dy, ps.map(p => p.id).join(',')].join('|');
    if (groupFitMemo && groupFitMemo.key === key) return groupFitMemo.v;
    const ids = new Set(ps.map(p => p.id));
    let v = { ok: true };
    for (const p of ps) {
      const r = station.canPlaceProp(p.t, p.x + dx, p.y + dy, p.w, p.h, p.id);
      if (r && r.ok) continue;
      if (r && r.error === 'OVERLAP') {
        const to = propRect(p, dx, dy), hit = station.props().find(q => !ids.has(q.id) && !propSpec(q.t).flat && rectsMeet(propRect(q), to));
        if (!hit) continue;
        v = { ok: false, error: 'OVERLAP', msg: 'Blocked by ' + (propSpec(hit.t).label || hit.t) + ' · choose a clear space' }; break;
      }
      if (r && r.error === 'NEEDS_SURFACE' && ps.some(q => q.id !== p.id && rectsMeet(propRect(q), propRect(p)))) continue;   // its table moves with it
      v = r || { ok: false, msg: 'blocked' }; break;
    }
    groupFitMemo = { key, v };
    return v;
  }
  function commitGroupMove(d, ev) {
    const dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty;
    if (!dx && !dy) { hideTip(); return; }
    const ids = groupIds.slice(), res = moveGroupBy(ids, dx, dy);
    feedback(refusalOf(res, ids, dx, dy), ev, 'moved ' + ids.length + ' together · Undo puts them back');
    if (res && res.ok) { landProps(ids, 25); renderSelection(); }
  }
  function nudgeGroup(dx, dy, ev) {
    const ids = groupIds.slice(), from = ids.map(id => station.propById(id)).filter(Boolean).map(p => propRect(p));
    const res = moveGroupBy(ids, dx, dy);
    if (res && res.ok) { snapTick('propmove'); pushMoves(from.map(r => ({ from: r, to: { x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy } }))); renderSelection(); }
    else { sfx('bad'); flashTip(ev, refusalOf(res, ids, dx, dy).msg || 'blocked — nothing moved'); }
    return true;
  }
  // a refused group move says what is in the way, the way its ghost did (the model's own refusal only knows "overlaps a prop")
  function refusalOf(res, ids, dx, dy) {
    if (!res || res.ok) return res;
    const fit = groupFit(ids.map(id => station.propById(id)).filter(Boolean), dx, dy);
    return fit && !fit.ok && fit.msg ? fit : res;
  }
  /* Delete on a group: every member — and every belt the box took with it (whole: each link with every tile no other link rides,
     taken up FIRST, while both its ends still stand) — in ONE transact, one UNDO */
  /* (repair 2026-10-11) the belt under each removed JUNCTION goes too when every one of its belts goes (station.removeLinks
     o.junctions — a junction's own tile is no link's, so it stayed a loose belt where the junction stood and a cut line could not
     be pasted back in place). A CUT takes up exactly what its clip carries — the belts whose two ends are both cut — and leaves a
     belt the box crossed that runs to a machine outside it where it is (the clip cannot bring it back: a cut is a move). */
  function cutLinksOf(ids) {
    const sel = new Set(ids);
    return linksMemoed().filter(l => l && l.from && l.to && l.from.prop !== l.to.prop && sel.has(l.from.prop) && sel.has(l.to.prop)).map(l => l.id);
  }
  function deleteGroup(ev, verb) {
    const was = selectionIds().map(id => station.propById(id)).filter(Boolean).map(p => Object.assign({}, p)), bs = beltSel(), cut = verb === 'CUT';
    if (!was.length && !bs) return false;
    if (warnSendCuts(was.map(p=>p.id), ev, null, cut ? 'CUT (CTRL+X)' : undefined)) return false;
    const liftIds = cut ? cutLinksOf(was.map(p => p.id)) : (bs ? bs.links : []), loose = cut ? [] : (bs ? bs.tiles : []);
    const nb = cut ? liftIds.length : (bs ? bs.links.length + bs.tiles.length : 0);
    const cells = cut ? linksMemoed().filter(l => liftIds.includes(l.id)).reduce((a, l) => a.concat(l.path || []), []) : (bs ? bs.cells : []);
    const res = station.transact(() => {
      if ((liftIds.length || loose.length || was.some(p => JUNCTION_TAG_TYPES[p.t])) && typeof station.removeLinks === 'function') {
        const rb = station.removeLinks(liftIds, loose, { junctions: was.filter(p => JUNCTION_TAG_TYPES[p.t]).map(p => p.id) }); if (!rb || !rb.ok) return rb;
      }
      for (const p of was) { const r = station.removeProp(p.id); if (!r || !r.ok) return r; }
      return { ok: true };
    }, cut ? 'CUT' : (!was.length ? (nb === 1 ? 'BELT' : 'BELTS') : undefined));
    if (res && res.ok) { pushFlash(was.map(p => propRect(p)).concat(cells.map(q => ({ x1: q.x, y1: q.y, x2: q.x, y2: q.y }))), true); was.forEach(p => vanishProp(p)); if (!was.length) sfxVanish(); setSelection([]); flashUndo(); }
    const what = (was.length ? was.length + (was.length === 1 ? ' thing' : ' things') : '') + (was.length && nb ? ' and ' : '') + (nb ? nb + (nb === 1 ? ' belt' : ' belts') : '');
    if (verb !== 'CUT') feedback(res, ev, 'removed ' + what + ' · Undo restores ' + (was.length + nb === 1 ? 'it' : 'them'));
    else if (!(res && res.ok)) feedback(res, ev, '');
    return !!(res && res.ok);
  }
  /* Ctrl+D on a group: the whole arrangement again — WITH the belts between its machines, their settings, names, briefs and crew
     (THE HAND part 2: it is a clip, laid beside itself) — and the copies become the selection, so Ctrl+D again lays the next one */
  function duplicateGroup(ev) {
    if (groupIds.length < 2 && !beltSel()) return false;
    return duplicateClip(ev);
  }
  /* ---------- THE HAND, part 2 (2026-10-11 — Andrew: "fully polish and integrate this into starnet", from his prototype) ----------
     BELTS IN THE BOX: a box takes the belts it crosses as well as the machines it touches — every link with a tile inside it,
     every loose belt tile, and every link whose two ends it took — and they are part of the selection: drawn gold, gone with
     DELETE (whole, every tile no other link rides), carried by COPY. A WHOLE LINE: a double-click (a double-tap, or the card's
     WHOLE LINE key) on a conveyor piece takes the line its belts join; its card offers COPY LINE / DELETE LINE.
     A PIECE OF FLOOR IN YOUR HAND: COPY / CUT put a CLIP in hand (station.copyLines — the machines with everything that makes
     each one THAT machine, a LOOP's passes and verdict, a BAY's role, brief and crew (only agents on this station), an INBOX's
     name and budget, and the belts between them; never a connector bind, a project folder, triggers or a SEND TO pointing out).
     It rides the COPY tool's own stamp (dupe.type 'lines'): the ghost follows the pointer, every piece and belt tile green where
     it fits and red where it does not, with the reason; R turns it a quarter; a click lays it EXACTLY (one undo, a pasted INBOX
     starts a new line) and it stays in hand; Esc or right-click puts it down. Where the drawn shape will not go a line is laid
     out to fit near the click (LineEdit.layoutGraphNear) — or refused, said. Ctrl+D lays the selection again beside itself.
     Every check is the model's, memoized per edit + spot + turn; nothing is written while you aim (H9). */
  let selBeltVer = -1, selBeltRef = null, selBeltMemo = null;
  // the belts selected right now (links that still exist, loose tiles still on the floor) + every tile they cover — or null
  function beltSel() {
    if (!selBelts || !station) return null;
    if (selBelts.key !== selectionIds().join(',')) { selBelts = null; return null; }   // the selection moved on without them
    if (selBeltVer === geoVer && selBeltRef === selBelts) return selBeltMemo;
    const have = new Map(linksMemoed().map(l => [l.id, l]));
    const links = selBelts.links.filter(id => have.has(id)), tiles = selBelts.tiles.filter(q => station.beltAt(q.x, q.y));
    const cells = [];
    for (const id of links) for (const q of (have.get(id).path || [])) cells.push({ x: q.x, y: q.y });
    for (const q of tiles) cells.push({ x: q.x, y: q.y });
    selBeltVer = geoVer; selBeltRef = selBelts;
    selBeltMemo = (links.length || tiles.length) ? { links, tiles, cells } : null;
    return selBeltMemo;
  }
  // the belts a box takes: every link with a tile inside it or whose two ends are both selected, every loose belt tile inside it
  let beltBoxMemo = null;
  function beltsInBox(r, ids) {
    const key = [geoVer, r.x1, r.y1, r.x2, r.y2, (ids || []).join(',')].join('|');
    if (beltBoxMemo && beltBoxMemo.key === key) return beltBoxMemo.v;
    const inR = (x, y) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2, sel = new Set(ids || []);
    const links = [], onLink = new Set(), cells = [];
    for (const l of linksMemoed()) {
      const path = l.path || [];
      for (const q of path) onLink.add(q.x + ',' + q.y);
      if (path.some(q => inR(q.x, q.y)) || (l.from && l.to && sel.has(l.from.prop) && sel.has(l.to.prop))) { links.push(l.id); for (const q of path) cells.push({ x: q.x, y: q.y }); }
    }
    const junc = new Set(station.props().filter(p => JUNCTION_TAG_TYPES[p.t]).map(p => p.x + ',' + p.y)), tiles = [];
    for (const b of beltsMemoed()) if (inR(b.x, b.y) && !onLink.has(b.x + ',' + b.y) && !junc.has(b.x + ',' + b.y)) { tiles.push({ x: b.x, y: b.y }); cells.push({ x: b.x, y: b.y }); }
    const v = { links, tiles, cells, n: links.length + tiles.length };
    beltBoxMemo = { key, v };
    return v;
  }
  // the selection is EXACTLY one whole line (every machine its belts join, nothing else) → { id, name, links } — else null
  function wholeLineOf(ps) {
    if (!ps || !ps.length || typeof station.lineMembers !== 'function' || ps.some(p => !CONNECT_TYPES[p.t])) return null;
    const m = station.lineMembers(ps[0].id);
    if (!m || m.ids.length < 2 || m.ids.length !== ps.length) return null;
    const set = new Set(ps.map(p => p.id));
    if (!m.ids.every(id => set.has(id))) return null;
    // its name rides its INBOX (read off the props, not the compiled lines — a line pasted a moment ago is not compiled yet)
    const inbox = ps.find(p => p.t === 'intake');
    return { id: ps[0].id, name: (station.lineNameAt && station.lineNameAt(ps[0].id)) || (inbox ? lineWordOf(inbox) : 'THIS LINE'), links: m.links.length };
  }
  // exactly one whole line: Del is the card's DELETE LINE (removeLine — every belt, the tiles under its junctions, a SEND TO into it)
  function deleteGroupOrLine(ev) {
    const line = lineSelectionOf(selectionIds().map(id => station.propById(id)).filter(Boolean));
    return line ? deleteLine(line.id, ev) : deleteGroup(ev);
  }
  // …and exactly that line's belts with it (a box that also took another line's belt is a group, not a line: Del takes that belt too)
  function lineSelectionOf(ps) {
    const line = wholeLineOf(ps);
    if (!line) return null;
    const bs = beltSel(), m = station.lineMembers(line.id), mine = new Set(m ? m.links : []);
    return bs && (bs.tiles.length || bs.links.some(id => !mine.has(id))) ? null : line;
  }
  // a double-click (double-tap, the card's WHOLE LINE) on a conveyor piece: every machine its belts join, and those belts
  function selectWholeLine(pid, ev) {
    const p = station.propById(pid), m = p && typeof station.lineMembers === 'function' ? station.lineMembers(pid) : null;
    if (!p || !m || m.ids.length < 2) { sfx('bad'); flashTip(ev, 'THIS PIECE IS ON NO LINE YET — BELT IT TO ANOTHER FIRST', false); return false; }
    setSelection(m.ids, { links: m.links, tiles: [] });
    sfx('click');
    const line = wholeLineOf(m.ids.map(id => station.propById(id)).filter(Boolean));
    floatAt({ x: p.x + (p.w || 1) / 2, y: p.y }, 'SELECTED · ' + (line ? line.name : 'THE LINE') + ' · ' + m.ids.length + ' PIECES', 'note');
    return true;
  }
  let lastTap = null;   // a touch tap on a conveyor piece — a second one on the same piece inside 380ms is a double-tap
  function onDblClick(ev) {
    if (tool !== 'select' || hand || touchArm || dropPick || drag) return;
    clearTimeout(inspectTimer);
    // the machine the double-click's first press selected — only when this double-click lands where that press did (build-19: a
    // double-click on empty floor 0.1 s after clicking a BAY elsewhere took that BAY's whole line); else what is under it now
    const near = clickMachine && (clickMachine.x == null || ev.clientX == null || Math.hypot(ev.clientX - clickMachine.x, ev.clientY - clickMachine.y) < CLICK_SLOP);
    const pid = clickMachine && near && performance.now()-clickMachine.t<600 ? clickMachine.id : propAtEvent(ev), p = pid && station.propById(pid);
    if (!p || !CONNECT_TYPES[p.t]) return;
    if (ev.preventDefault) ev.preventDefault();
    selectWholeLine(p.id, ev);
  }
  // DELETE LINE: every machine of it and every belt between them — one undo; a SEND TO pointing into it is let go (the model's)
  // (verb 'CUT': the same removal under a CUT undo slot, said by the clip in hand instead — Ctrl+X on a whole line)
  function deleteLine(pid, ev, verb) {
    const m = typeof station.lineMembers === 'function' ? station.lineMembers(pid) : null;
    if (!m || typeof station.removeLine !== 'function') return false;
    const was = m.ids.map(id => station.propById(id)).filter(Boolean).map(p => Object.assign({}, p)), cut = verb === 'CUT';
    if (warnSendCuts(m.ids, ev, null, cut ? 'CUT (CTRL+X)' : undefined)) return false;
    const line = wholeLineOf(was), name = line ? line.name : 'THE LINE';
    const res = cut ? station.transact(() => station.removeLine(pid), 'CUT') : station.removeLine(pid);
    if (res && res.ok) {
      pushFlash(was.map(p => propRect(p)), true); was.forEach(p => vanishProp(p)); setSelection([]); flashUndo();
      const c = was[0]; if (c && !cut) floatAt({ x: c.x + (c.w || 1) / 2, y: c.y }, 'REMOVED · ' + name + ' · CTRL+Z', 'bad');
    }
    if (!cut) feedback(res, ev, 'removed ' + name.toLowerCase() + ' — ' + was.length + ' pieces and their belts · Undo restores it');
    else if (!(res && res.ok)) feedback(res, ev, '');
    return cut ? !!(res && res.ok) : true;
  }
  // a lone CONVEYOR piece copies as a clip too (its crew, brief and settings with it); lone furniture stays the COPY tool's stamp
  const clipWorthy = () => { const p = selectedPropId && station.propById(selectedPropId); return !!(p && CONNECT_TYPES[p.t]); };
  function clipOfSelection() {
    const ids = selectionIds();
    if (!ids.length || typeof station.copyLines !== 'function') return null;
    const r = station.copyLines(ids, { agent: agentHere, turns: t => canTurn(t) });
    return r && r.ok ? r.clip : null;
  }
  let clipSeq = 0;
  const clipWord = c => c.n + (c.n === 1 ? ' PIECE' : ' PIECES') + (c.nb ? ' · ' + c.nb + (c.nb === 1 ? ' BELT' : ' BELTS') : '');
  function holdClip(held, ev, said) {
    selectTool('dupe', { keepGroup: true, silent: true }); dupe = held; clipGhostMemo = null; sfx('click');
    flashTip(ev, said || ('HOLDING ' + held.label + ' — click to place · R turns it · right-click to drop'), true);
    setHint('holding ' + held.label + ' — click to place a copy (it stays in hand) · R turns it · right-click / Esc puts it down');
  }
  // COPY (cut: CUT) → a CLIP in hand, the ghost under the pointer; Ctrl+V picks the last one up again
  function copyClip(ev, cut) {
    const ps = selectionIds().map(id => station.propById(id)).filter(Boolean), line = wholeLineOf(ps), c = clipOfSelection();
    if (!c) { sfx('bad'); flashTip(ev, 'SELECT MACHINES TO COPY — DRAG A BOX ACROSS THEM, OR DOUBLE-CLICK A LINE', false); return true; }
    const held = { type: 'lines', clip: c, rot: 0, cid: ++clipSeq, label: line ? line.name : clipWord(c) };
    const notes = [];
    if (c.dropped) notes.push(c.dropped + ' SEND TO LEFT OUT (IT POINTS OUTSIDE THE COPY)');
    if (c.oldBelts) notes.push(c.oldBelts + ' OLD HAND-OFF BELT' + (c.oldBelts === 1 ? '' : 'S') + ' LEFT OUT (A HAND-OFF IS SEND TO)');
    if (c.crewLeft) notes.push(c.crewLeft + ' CREW LEFT OUT (NOT ON THIS STATION)');
    /* a COPY carries the belts BETWEEN the copied machines only — the box's other belts (counted on its card, drawn gold) are said,
       never dropped silently (wave 2, build-22: "3 things · 4 belts" copied as "1 BELT"); a CUT says the same in cutLeavesBehind */
    if (!cut) {
      const bs = beltSel(), carried = new Set(cutLinksOf(ps.map(p => p.id))), left = bs ? bs.links.filter(id => !carried.has(id)).length + bs.tiles.length : 0;
      if (left) notes.push(left + (left === 1 ? ' BELT' : ' BELTS') + ' LEFT OUT (' + (left === 1 ? 'IT RUNS' : 'THEY RUN') + ' OUTSIDE THE COPY)');
    }
    const lost = cut ? cutLeavesBehind(ps) : [];
    const whole = cut ? lineSelectionOf(ps) : null;
    if (cut && !(whole ? deleteLine(whole.id, ev, 'CUT') : deleteGroup(ev, 'CUT'))) return true;   // (refused: nothing was taken, nothing is held)
    lastCopy = held;
    holdClip(held, ev, (cut ? 'CUT · ' : 'COPIED · ') + held.label + (notes.length ? ' · ' + notes.join(' · ') : '') + (lost.length ? ' · NOT CARRIED: ' + lost.join(', ') : '') + ' — click to place · R turns it');
    if (lost.length) setHint('holding ' + held.label + ' — the paste is a NEW copy: ' + lost.join(', ').toLowerCase() + ' did not come with it (set them again on the paste) · Ctrl+Z puts the original back');
    return true;
  }
  /* what a CUT takes off the floor that its clip cannot bring back (a paste is a new copy with new ids): said on the cut, never
     silent — the project folder and any schedule / webhook of an INBOX (the sidecar keys them by the old INBOX), a connector or
     plugin bind, a desk's owner, a SEND TO from another line into it, and the belts the box crossed that run outside it */
  function cutLeavesBehind(ps) {
    const ids = new Set(ps.map(p => p.id)), out = [];
    const ins = ps.filter(p => p.t === 'intake');
    if (ins.some(p => typeof p.projectRoot === 'string' && p.projectRoot.trim())) out.push('THE PROJECT FOLDER');
    if (ins.length) out.push('ANY SCHEDULE OR WEBHOOK ON ' + (ins.length === 1 ? 'ITS INBOX' : 'ITS INBOXES'));
    if (ps.some(p => (p.t === 'connector_portal' && p.connectorId) || (p.t === 'plugin_terminal' && p.pluginId))) out.push('CONNECTOR / PLUGIN BINDS');
    if (ps.some(p => WORKSTATION_TYPES[p.t] && p.agentId)) out.push('DESK OWNERS');
    if (station.props().some(p => !ids.has(p.id) && typeof p.sendTo === 'string' && ids.has(p.sendTo))) out.push('A SEND TO FROM ANOTHER LINE');
    const bs = beltSel(), carried = new Set(cutLinksOf(ps.map(p => p.id))), stay = bs ? bs.links.filter(id => !carried.has(id)).length + bs.tiles.length : 0;
    if (stay) out.push(stay + (stay === 1 ? ' BELT' : ' BELTS') + ' OUTSIDE IT (LEFT WHERE ' + (stay === 1 ? 'IT RUNS' : 'THEY RUN') + ')');
    return out;
  }
  function cutSelected(ev) {
    if (!selectionIds().length) { sfx('bad'); flashTip(ev, 'SELECT SOMETHING TO CUT FIRST', false); return true; }
    return copyClip(ev, true);
  }
  // Ctrl+D: the selection laid again beside itself (right, below, left, above — further out each time), the copies selected
  function duplicateClip(ev) {
    const c = clipOfSelection();
    if (!c) { sfx('bad'); flashTip(ev, 'select something to duplicate', false); return true; }
    const tries = [];   // (a line keeps two tiles of floor between it and its copy — side by side they read as one long line)
    for (let gap = c.nb ? 2 : 0; gap <= 10; gap++) for (const s of [0, 1, -1, 2, -2]) tries.push([c.x0 + c.w + gap, c.y0 + s], [c.x0 + s, c.y0 + c.h + gap], [c.x0 - c.w - gap, c.y0 + s], [c.x0 + s, c.y0 - c.h - gap]);
    for (const [ax, ay] of tries) {
      if (!(station.checkPaste(c, ax, ay) || {}).ok || !(station.probePaste(c, ax, ay) || {}).ok) continue;   // (asked first: a refused paste re-bakes the floor)
      const res = station.pasteLines(c, ax, ay, { agent: agentHere, label: 'DUPLICATE' });
      if (!res || !res.ok) continue;
      const made = res.ids.map(id => station.propById(id)).filter(Boolean);
      pushFlash(made.map(p => propRect(p)), false);
      landProps(made.slice().sort((a, b) => a.x - b.x || a.y - b.y).map(p => p.id), 40);
      if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
      setSelection(res.ids, { links: res.links || [], tiles: [] });
      flashTip(ev, 'duplicated · ' + clipWord(c).toLowerCase() + ' · the copies are selected · Ctrl+D again for another', true);
      return true;
    }
    sfx('bad'); flashTip(ev, 'no clear floor beside it for a copy — Ctrl+C, then click where there is room', false);
    return true;
  }
  // the paste is centred on the pointer (the prototype's anchor), so turning it keeps it under the hand
  const clipAnchor = (c, tx, ty) => ({ ax: tx - Math.floor((c.w - 1) / 2), ay: ty - Math.floor((c.h - 1) / 2) });
  let clipGhostMemo = null;
  // the paste ghost at a pointer tile — the model's pure check, then (only when that says yes) its probe; memoized per edit + spot + turn
  function clipGhost(tx, ty) {
    const c = dupe.clip, { ax, ay } = clipAnchor(c, tx, ty), key = [geoVer, dupe.cid, dupe.rot | 0, ax, ay].join('|');
    if (clipGhostMemo && clipGhostMemo.key === key) return clipGhostMemo.g;
    let v = station.checkPaste(c, ax, ay);
    if (v && v.ok) { const pr = station.probePaste(c, ax, ay); if (!pr || !pr.ok) v = Object.assign({ badNodes: [], badTiles: [] }, pr || { ok: false }, { whole: true }); }
    const rects = c.nodes.map(n => ({ x1: ax + n.x, y1: ay + n.y, x2: ax + n.x + n.w - 1, y2: ay + n.y + n.h - 1 }));
    const g = { clip: true, kind: 'dupe', tx, ty, ax, ay, rects, v: v || { ok: false }, badNodes: new Set((v && v.badNodes) || []), badTiles: new Set((v && v.badTiles) || []) };
    clipGhostMemo = { key, g };
    return g;
  }
  /* LAID OUT TO FIT — ASKED, NEVER PROMISED (wave 2, build-04). Where the drawn copy will not go, a click lays the line out near the
     pointer (LineEdit.layoutGraphNear) — and the ghost used to promise A CLICK LAYS IT OUT for every red spot, then the click said
     PART OF IT IS OFF THE STATION FLOOR. Now the layout engine is asked OFF the frame path, once the pointer has rested on a tile
     (a 120 ms debounce — the whole-floor layout is never asked per frame or per tile crossed), memoized per edit + clip + turn +
     tile; the ghost says only what it answered (and nothing while it is still asked), and the click lays exactly that answer. */
  const layable = c => !!(c && c.nodes && c.nodes.length && c.nodes.every(n => CONNECT_TYPES[n.t]));
  let clipLaid = null, clipLaidT = 0, clipLaidAt = null;
  const clipLaidKey = () => [geoVer, dupe.cid, dupe.rot | 0].join('|');
  function layClipNear(c, at) {
    if (typeof LineEdit === 'undefined' || !LineEdit.layoutGraphNear || typeof station.clipGraph !== 'function') return { ok: false, msg: 'this floor cannot lay a copy out' };
    try {
      const gr = station.clipGraph(c, { agent: agentHere });
      if (!gr || !gr.ok) return { ok: false, msg: (gr && gr.msg) || 'this copy cannot be laid out' };
      const L = LineEdit.layoutGraphNear(station, gr.graph, { x: at.tx, y: at.ty });
      return L && L.ok ? { ok: true, L } : { ok: false, msg: (L && L.msg) || 'there is no clear floor near here to lay this copy out on' };
    } catch (e) { return { ok: false, msg: 'the layout failed — ' + String((e && e.message) || e) }; }
  }
  // the engine's answer for this tile: { ok, L } | { ok:false, msg } — undefined while it is still being asked
  function clipLaidFor(tx, ty) {
    const k = clipLaidKey(), tk = tx + ',' + ty;
    if (!clipLaid || clipLaid.key !== k) clipLaid = { key: k, tiles: new Map() };
    if (clipLaid.tiles.has(tk)) return clipLaid.tiles.get(tk);
    if (!clipLaidAt || clipLaidAt.tx !== tx || clipLaidAt.ty !== ty) {   // a new tile restarts the wait: asked once the pointer rests
      clipLaidAt = { tx, ty };
      clearTimeout(clipLaidT); clipLaidT = setTimeout(stepClipLaid, 120);
    }
    return undefined;
  }
  function stepClipLaid() {
    clipLaidT = 0;
    const at = clipLaidAt; clipLaidAt = null;
    if (!at || !running || !station || !dupe || !dupe.clip || !clipLaid || clipLaid.key !== clipLaidKey()) return;
    if (clipLaid.tiles.size > 48) clipLaid.tiles.clear();   // (a bounded memo: each answer holds a layout)
    clipLaid.tiles.set(at.tx + ',' + at.ty, layClipNear(dupe.clip, at));
  }
  // a click with a clip in hand: lay it EXACTLY where the ghost was green — else, a line laid out to fit near the click (the engine's
  // answer the ghost showed, asked now if the ghost never got it) — else, said: the layout's own reason when it was the one asked
  function pasteClipAt(w, ev) {
    const c = dupe.clip, { ax, ay } = clipAnchor(c, w.tx, w.ty), g = clipGhost(w.tx, w.ty);
    let res = g.v && g.v.ok ? station.pasteLines(c, ax, ay, { agent: agentHere }) : g.v, laid = false, lay = null;
    if (!(res && res.ok) && layable(c)) {
      const known = clipLaid && clipLaid.key === clipLaidKey() ? clipLaid.tiles.get(w.tx + ',' + w.ty) : undefined;
      lay = known || layClipNear(c, w);
      if (lay.ok) {
        const r2 = station.pasteLinesLaid(c, lay.L, { agent: agentHere });
        if (r2 && r2.ok) { res = r2; laid = true; } else lay = { ok: false, msg: (r2 && (r2.short || r2.msg)) || 'the copy could not be laid' };
      }
    }
    if (!(res && res.ok)) { sfx('bad'); flashTip(ev, 'CAN’T PASTE HERE — ' + String((lay && !lay.ok && lay.msg) || (res && (res.short || res.msg)) || 'it does not fit').toUpperCase(), false); return; }
    const made = (res.ids || []).map(id => station.propById(id)).filter(Boolean);
    pushFlash(made.map(p => propRect(p)), false);
    landProps(made.slice().sort((a, b) => a.x - b.x || a.y - b.y).map(p => p.id), 40);
    if (made.length) floatAt({ x: (Math.min(...made.map(p => p.x)) + Math.max(...made.map(p => p.x + (p.w || 1)))) / 2, y: Math.min(...made.map(p => p.y)) }, 'PASTED · ' + dupe.label + (laid ? ' · LAID OUT TO FIT' : ''), 'ok');
    if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
    if (made.some(p => p.t === 'intake') && typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();
    setHint('placed · click again for another (it stays in hand) · R turns it · right-click / Esc puts it down');
  }
  // R with a clip in hand: a quarter turn clockwise (Shift+R: back) — a clip holding a piece that only stands one way does not turn
  function turnClip(n, ev) {
    if (!dupe || dupe.type !== 'lines') return;
    if (!WorldModel.clipTurns || !WorldModel.clipTurns(dupe.clip)) { sfx('bad'); flashTip(ev, 'THIS COPY CAN’T TURN — A PIECE IN IT ONLY STANDS ONE WAY', false); return; }
    dupe = Object.assign({}, dupe, { clip: WorldModel.rotateClip(dupe.clip, n), rot: ((dupe.rot | 0) + n) & 3 });
    clipGhostMemo = null; sfx('click');
    flashTip(ev, 'TURNED · ' + (dupe.rot * 90) + ' DEGREES', true);
  }
  // the group's card: up to three of them in the art well, how many and what, then the three things a group can do
  /* ---------- THE ROOM CARD (2026-10-01 build-mode upgrade, phase 2) ----------
     A selected room: its deck in the art well, its name (type to rename — Enter or leaving the field saves it), its size, then
     (a drag on its floor moves it, everything on it riding along — SELECT MOVES, 10-11), RESIZE (its gold handles: drag an edge out to grow it, in to shrink it — WorldModel.resizeRoom,
     everything on it must still stand on it, one undo), FLOOR (arms SURFACE), FURNISH (a whole furnished room in one click: the
     station builder's own refurnish — its furniture cleared, the style laid, floor and walls too; lines and agents' desks stay;
     one undo), CLEAR (its furniture goes; lines and desks stay) and DELETE (the spawn room is protected). */
  function selectRoom(rid) {
    const rm = rid ? station.roomById(rid) : null;
    selectedPropId = null; groupIds = []; selBelts = null; positionOpen = false; furnishOpen = false; roomDelArmedAt = 0; roomAsk = null; sendCutArm = null;
    selectedRoomId = rm ? rm.id : null;
    renderSelection();
    if (rm) { setHint('Selected ' + (rm.name || 'the room') + ' · drag inside it to move it · drag a gold handle to resize it · arrows nudge it · Del deletes'); sfx('click'); }
    else setHint();
  }
  function roomTiles(rm) { let n = 0; for (const r of rm.rects) n += (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1); return n; }
  // the furnisher is the station builder's own planner (planned on a copy, applied in one undo) — Build mode only hands it the page
  const furnishReady = () => typeof StationBuilder !== 'undefined' && !!StationBuilder.planEdit && !!StationBuilder.apply && typeof RoomStyles !== 'undefined' && !!RoomStyles.ROOMS
    && typeof Pipeline !== 'undefined' && typeof WorkflowLine !== 'undefined' && typeof StationTemplates !== 'undefined';
  function furnishEnv() {
    const crew = (typeof App !== 'undefined' && App.agents ? App.agents() : []).map(x => ({ id: x.id, name: x.name }));
    return { WorldModel, Pipeline, WorkflowLine, crew, heroId: (typeof App !== 'undefined' && App.heroId) ? App.heroId() : null,
      StationTemplates: typeof StationTemplates !== 'undefined' ? StationTemplates : null, PropSprites: typeof PropSprites !== 'undefined' ? PropSprites : null,
      RoomStyles: typeof RoomStyles !== 'undefined' ? RoomStyles : null, LineLayout: typeof LineLayout !== 'undefined' ? LineLayout : null,
      LineEdit: typeof LineEdit !== 'undefined' ? LineEdit : null, EquipmentHelp: typeof EquipmentHelp !== 'undefined' ? EquipmentHelp : null, canRecruit: false };
  }
  const styleLabel = sid => String(((typeof RoomStyles !== 'undefined' && RoomStyles.ROOMS[sid]) || {}).name || sid).replace(/^(a|an) /i, '').toUpperCase();
  // a style's tile shows its signature piece (the feature wall's centre), else its first real piece
  function styleIcon(sid) {
    const rec = RoomStyles.ROOMS[sid] || {}, known = t => t && typeof PropSprites !== 'undefined' && PropSprites.spec && PropSprites.spec(t);
    const c = (rec.feature && rec.feature.centre) || [];
    for (const t of c) if (known(t)) return t;
    for (const set of rec.centre || []) for (const pc of set.pieces || []) if (known(pc[0]) && !/rug/.test(pc[0])) return pc[0];
    return 'plant';
  }
  /* the edit is planned on a copy first (every check the station builder makes), then applied as planned in one undo. A plan
     that takes out EQUIPMENT — a piece that gives agents an ability (object = capability), which the new style does not
     bring back — is not applied on the first click: the card names what goes and asks once more (roomAsk). */
  function runRoomEdit(req, ev, ask, confirmed) {
    const env = furnishEnv();
    let r;
    try { r = StationBuilder.planEdit(station.serialize(), req, env); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!r || !r.ok) { sfx('bad'); flashTip(ev, (r && r.error) || 'that does not fit this room'); return null; }
    const gear = gearLost(r.plan);
    if (gear.length && !confirmed) { roomAsk = Object.assign({ gear }, ask); sfx('tick'); renderSelection(); return null; }
    roomAsk = null;
    let a;
    try { a = StationBuilder.apply(station, r.plan, env); } catch (e) { a = { ok: false, error: String((e && e.message) || e) }; }
    if (!a || !a.ok) { sfx('bad'); flashTip(ev, (a && a.error) || 'the room could not be changed — nothing was'); return null; }
    return a;
  }
  // the equipment a plan removes and does not put back: "DISH (WEB)" — the builder's own capability table names the ability
  function gearLost(plan) {
    const spec = (plan && plan.spec) || {}, back = new Set(((spec.props) || []).map(q => q && q.t).filter(Boolean)), out = [], seen = {};
    for (const id of spec.removeProps || []) {
      const p = station.propById(id); if (!p || back.has(p.t)) continue;
      const cap = WorldModel.capForProp ? WorldModel.capForProp(p.t) : null; if (!cap) continue;
      const k = p.t + ':' + cap; if (seen[k]) continue; seen[k] = 1;
      out.push(propLabel(p.t) + ' (' + String((WorldModel.CAP_LABEL || {})[cap] || cap).toUpperCase() + ')');
    }
    return out;
  }
  function furnishRoom(rm, sid, ev, confirmed) {
    if (!rm.name) { sfx('bad'); flashTip(ev, 'name this room first — then FURNISH it'); return; }
    const before = new Set(station.props().map(p => p.id)), was = station.props().filter(p => station.roomAt(p.x, p.y) === rm.id).map(p => Object.assign({}, p));
    if (!runRoomEdit({ refurnish: { room: rm.name, style: sid } }, ev, { kind: 'furnish', sid }, confirmed)) return;
    furnishOpen = false;
    was.filter(p => !station.propById(p.id)).forEach(p => vanishProp(p));
    landProps(station.props().filter(p => !before.has(p.id)).sort((a, b) => a.y - b.y || a.x - b.x).map(p => p.id), 28);   // the new room drops in, piece by piece
    renderSelection(); flashUndo();
    sfx('chime'); flashTip(ev, 'furnished as ' + styleLabel(sid).toLowerCase() + ' · floor and walls too · one Undo puts it back', true);
  }
  function clearRoom(rm, ev, confirmed) {
    if (!rm.name) { sfx('bad'); flashTip(ev, 'name this room first — then CLEAR it'); return; }
    const was = station.props().filter(p => station.roomAt(p.x, p.y) === rm.id).map(p => Object.assign({}, p));
    if (!runRoomEdit({ clear: rm.name }, ev, { kind: 'clear' }, confirmed)) return;
    const gone = was.filter(p => !station.propById(p.id));
    gone.forEach(p => vanishProp(p)); renderSelection(); flashUndo();
    flashTip(ev, 'cleared ' + gone.length + (gone.length === 1 ? ' piece' : ' pieces') + ' · its lines and desks stay · one Undo brings them back', true);
  }
  function deleteSelectedRoom(ev) {
    const rm = station.roomById(selectedRoomId); if (!rm) return;
    if (rm.id === station.spawnRoomId()) { sfx('bad'); flashTip(ev, 'the spawn room can’t be deleted — drag it to move it instead'); return; }
    const now = performance.now();
    // (after a SEND TO cut warning FOR THIS ROOM the repeat confirms anywhere in its own 6 s window — reading it took longer than
    // the 2.5 s arm, live 10-12; any other room, or a lapsed warning, keeps the 2.5 s confirm)
    if (!roomDelArmedAt || now - roomDelArmedAt > (cutArmFor(rm.id) ? 6000 : 2500)) { roomDelArmedAt = now; sfx('tick'); flashTip(ev, 'press Delete again to delete ' + (rm.name || 'this room') + ' — everything on it goes (one Undo brings it back)'); return; }
    /* deselect only once the room is GONE (final floor lane M15): after a SEND TO cut warning ("DELETE AGAIN TO CONTINUE")
       the room stays selected and armed, so the next Delete goes straight through; a refused delete leaves a room that still stands */
    roomDelArmedAt = 0;
    if (doDeleteRoom(rm.id, ev)) selectedRoomId = null; else if (cutArmFor(rm.id)) roomDelArmedAt = performance.now();
    renderSelection(); setHint();
  }
  function nudgeRoom(dx, dy, ev) {
    const rm = station.roomById(selectedRoomId); if (!rm) return;
    const from = rm.rects.map(r => Object.assign({}, r));
    const res = keepsHalls(() => station.moveRoom(rm.id, dx, dy));
    if (res && res.ok) { snapTick('move'); pushMoves(from.map(r => ({ from: r, to: { x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy } }))); renderSelection(); }
    else { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked — the room did not move'); }
  }
  // the selected room's eight handles (corners + edge middles), in world px; a plain rectangle only (resizeRoom keeps one rect)
  function roomHandles(rm, t) {
    const r = rm.rects[0], X1 = r.x1 * t, X2 = (r.x2 + 1) * t, Y1 = r.y1 * t, Y2 = (r.y2 + 1) * t, mx = (X1 + X2) / 2, my = (Y1 + Y2) / 2;
    return [
      { x: X1, y: Y1, e: { l: 1, t: 1 }, cur: 'nwse-resize' }, { x: mx, y: Y1, e: { t: 1 }, cur: 'ns-resize' }, { x: X2, y: Y1, e: { r: 1, t: 1 }, cur: 'nesw-resize' },
      { x: X2, y: my, e: { r: 1 }, cur: 'ew-resize' }, { x: X2, y: Y2, e: { r: 1, b: 1 }, cur: 'nwse-resize' }, { x: mx, y: Y2, e: { b: 1 }, cur: 'ns-resize' },
      { x: X1, y: Y2, e: { l: 1, b: 1 }, cur: 'nesw-resize' }, { x: X1, y: my, e: { l: 1 }, cur: 'ew-resize' },
    ];
  }
  // a handle under the pointer — or anywhere along an edge (a narrower band), so a long wall need not be grabbed at its middle
  function roomHandleAt(ev) {
    const rm = selectedRoomId && station.roomById(selectedRoomId);
    if (!rm || rm.rects.length !== 1 || !cv) return null;
    const c = toCanvas(ev), t = T(), wx = (c.x - panX) / zoom, wy = (c.y - panY) / zoom, R = Math.max(t * 0.45, 9 / zoom);
    let best = null, bd = Infinity;
    roomHandles(rm, t).forEach((h, i) => { const d = Math.hypot(wx - h.x, wy - h.y); if (d < R && d < bd) { bd = d; best = Object.assign({ i }, h); } });
    if (best) return best;
    const r = rm.rects[0], X1 = r.x1 * t, X2 = (r.x2 + 1) * t, Y1 = r.y1 * t, Y2 = (r.y2 + 1) * t, B = Math.max(t * 0.22, 6 / zoom);
    const inX = wx > X1 + B && wx < X2 - B, inY = wy > Y1 + B && wy < Y2 - B;
    if (inX && Math.abs(wy - Y1) < B) return { i: 1, e: { t: 1 }, cur: 'ns-resize' };
    if (inX && Math.abs(wy - Y2) < B) return { i: 5, e: { b: 1 }, cur: 'ns-resize' };
    if (inY && Math.abs(wx - X1) < B) return { i: 7, e: { l: 1 }, cur: 'ew-resize' };
    if (inY && Math.abs(wx - X2) < B) return { i: 3, e: { r: 1 }, cur: 'ew-resize' };
    return null;
  }
  // the rect a resize drag asks for: the grabbed edges follow the pointer by whole tiles, never past the room's minimum
  function resizedRect(d) {
    const rm = station.roomById(d.roomId); if (!rm) return null;
    const r0 = rm.rects[0], e = d.edge, min = rm.kind === 'corridor' ? 1 : (station.MIN_ROOM || 3);
    const dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty, r = { x1: r0.x1, y1: r0.y1, x2: r0.x2, y2: r0.y2 };
    if (e.l) r.x1 = Math.min(r0.x1 + dx, r0.x2 - min + 1);
    if (e.r) r.x2 = Math.max(r0.x2 + dx, r0.x1 + min - 1);
    if (e.t) r.y1 = Math.min(r0.y1 + dy, r0.y2 - min + 1);
    if (e.b) r.y2 = Math.max(r0.y2 + dy, r0.y1 + min - 1);
    return r;
  }
  // the same two checks resizeRoom makes (the footprint as a room, and nothing on it left off the deck), named for the ghost
  let resizeMemo = null;
  function resizeCheck(rm, nr) {
    const key = [geoVer, rm.id, nr.x1, nr.y1, nr.x2, nr.y2].join('|');
    if (resizeMemo && resizeMemo.key === key) return resizeMemo.v;
    let v = station.canPlaceRoom([nr], rm.kind, rm.id);
    if (v && v.ok) {
      const inOld = (x, y) => rm.rects.some(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2), inNew = (x, y) => x >= nr.x1 && x <= nr.x2 && y >= nr.y1 && y <= nr.y2;
      outer: for (const p of station.props()) for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++)
        if (inOld(x, y) && !inNew(x, y)) { v = { ok: false, error: 'CUTS_CONTENTS', msg: 'Move the ' + propLabel(p.t) + ' first · it would be left off the deck' }; break outer; }
      if (v.ok) for (const k of Object.keys(station.belts() || {})) { const q = k.split(','); if (inOld(+q[0], +q[1]) && !inNew(+q[0], +q[1])) { v = { ok: false, error: 'CUTS_CONTENTS', msg: 'A belt would be left off the deck · clear it first' }; break; } }
    } else v = { ok: false, error: (v && v.error) || 'BLOCKED', msg: String((v && v.msg) || 'blocked').replace(/^\w/, c => c.toUpperCase()) };
    resizeMemo = { key, v };
    return v;
  }
  function commitRoomResize(d, ev) {
    const rm = station.roomById(d.roomId); if (!rm) return;
    const nr = resizedRect(d), r0 = rm.rects[0];
    if (!nr || (nr.x1 === r0.x1 && nr.y1 === r0.y1 && nr.x2 === r0.x2 && nr.y2 === r0.y2)) { hideTip(); return; }
    const pre = resizeCheck(rm, nr);
    const res = pre && pre.ok ? keepsHalls(() => station.resizeRoom(rm.id, nr)) : pre;
    feedback(res, ev, 'resized to ' + (nr.x2 - nr.x1 + 1) + ' × ' + (nr.y2 - nr.y1 + 1) + ' · Undo puts it back');
    if (res && res.ok) { pushFlash([nr], false); renderSelection(); }
  }
  // on the floor: the selected room in gold, and its handles (the hovered one lit)
  function drawRoomSelection(t) {
    const rm = station.roomById(selectedRoomId); if (!rm) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(244,200,112,.9)'; ctx.lineWidth = 1.5 / zoom;
    for (const r of rm.rects) ctx.strokeRect(r.x1 * t + 0.75 / zoom, r.y1 * t + 0.75 / zoom, (r.x2 - r.x1 + 1) * t - 1.5 / zoom, (r.y2 - r.y1 + 1) * t - 1.5 / zoom);
    if (rm.rects.length === 1 && tool === 'select') {
      const s = Math.max(5 / zoom, t * 0.24);
      roomHandles(rm, t).forEach((h, i) => {
        ctx.fillStyle = i === hoverHandle ? 'rgba(255,236,180,1)' : 'rgba(244,200,112,.95)'; ctx.fillRect(h.x - s / 2, h.y - s / 2, s, s);
        ctx.strokeStyle = 'rgba(24,18,8,.9)'; ctx.lineWidth = 1 / zoom; ctx.strokeRect(h.x - s / 2, h.y - s / 2, s, s);
      });
    }
    ctx.restore();
  }
  function renderRoomCard(host, rm) {
    const isSpawn = rm.id === station.spawnRoomId(), corridor = rm.kind === 'corridor', plain = rm.rects.length === 1;
    const kd = station.ROOM_KINDS[rm.kind] || {}, b = rm.rects[0];
    const shape = plain ? (b.x2 - b.x1 + 1) + ' × ' + (b.y2 - b.y1 + 1) : rm.rects.length + ' sections';
    host.innerHTML = '<div class="refit-sel-head"><span class="refit-sel-art is-room" aria-hidden="true"></span><span class="refit-sel-name">'
      + '<input class="refit-room-name" type="text" maxlength="40" aria-label="Room name" placeholder="name this room" value="' + esc(rm.name || '') + '">'
      + '<small>' + esc((kd.label || rm.kind) + ' · ' + shape + ' · ' + roomTiles(rm) + ' tiles' + (isSpawn ? ' · the spawn room' : '') + ' · drag inside to move · arrows nudge') + '</small></span>'
      + '<button class="bb sm refit-sel-x" type="button" aria-label="Deselect" data-tip="Let go of the room · Esc">\u2715</button></div><div class="refit-selection-actions"></div>';
    // the art well: the room's own deck, painted by the bake
    try {
      const matId = station.matOfRoom ? station.matOfRoom(rm.id) : (rm.floorMat || kd.mat);
      const hue = (station.FLOOR_STYLES[rm.floorStyle] || station.FLOOR_STYLES[kd.floor] || station.FLOOR_STYLES.hull || {}).base || '#556';
      host.querySelector('.refit-sel-art').appendChild(matSwatchCanvas(matId || 'plate', hue, 7, 4));
    } catch (_) {}
    host.querySelector('.refit-sel-x').onclick = () => { selectRoom(null); sfx('click'); };
    // the name: type to rename — Enter or leaving the field saves it (Esc puts it back)
    const nameEl = host.querySelector('.refit-room-name');
    let saved = rm.name || '';
    const saveName = () => {
      const v = (nameEl.value || '').trim();
      if (v === saved) return;
      const res = station.renameRoom(rm.id, v);
      if (res && res.ok) { saved = v; sfx('click'); } else { sfx('bad'); nameEl.value = saved; }
    };
    nameEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } else if (e.key === 'Escape') { e.preventDefault(); nameEl.value = saved; nameEl.blur(); } };
    nameEl.onblur = saveName;
    const actions = host.querySelector('.refit-selection-actions');
    const key = (label, k, fn, cls) => { const el = document.createElement('button'); el.className = 'bb sm refit-sel-act' + (cls ? ' ' + cls : ''); el.type = 'button'; el.innerHTML = '<span>' + esc(label) + '</span>' + (k ? '<kbd>' + esc(k) + '</kbd>' : ''); el.onclick = fn; actions.appendChild(el); return el; };
    if (plain) key('RESIZE', 'edges', () => { sfx('click'); flashTip(orientEv(), 'drag a gold handle on its edge — out to grow it, in to shrink it', true); });
    key('FLOOR', '3', () => { selectTool('paint'); flashTip(orientEv(), 'pick a finish, then click the room to lay it', true); });
    if (!corridor && plain && furnishReady()) key('FURNISH', '', () => { furnishOpen = !furnishOpen; sfx('click'); renderSelection(); }, 'refit-room-furnish').setAttribute('aria-expanded', String(furnishOpen));
    if (!corridor && furnishReady() && station.props().some(p => station.roomAt(p.x, p.y) === rm.id)) key('CLEAR', '', () => clearRoom(rm, orientEv()));
    const del = key(isSpawn ? 'PROTECTED' : 'DELETE', isSpawn ? '' : 'Del', () => deleteSelectedRoom(orientEv()), 'refit-sel-del');
    if (isSpawn) { del.disabled = true; del.setAttribute('data-tip', 'the spawn room can’t be deleted — drag it to move it instead'); }
    // the ask: what equipment goes, and the two ways on — never applied until FURNISH ANYWAY / CLEAR ANYWAY
    if (roomAsk) {
      const ask = document.createElement('div'); ask.className = 'refit-room-ask'; ask.setAttribute('role', 'alert');
      const what = roomAsk.kind === 'furnish' ? styleLabel(roomAsk.sid) : 'CLEAR';
      ask.innerHTML = '<span>' + esc(what) + ' takes out ' + esc(roomAsk.gear.join(' · ')) + ' — agents here lose what ' + (roomAsk.gear.length === 1 ? 'it gives' : 'they give') + '</span>'
        + '<div class="refit-room-ask-keys"><button type="button" class="bb sm refit-sel-act refit-sel-del">' + (roomAsk.kind === 'furnish' ? 'FURNISH ANYWAY' : 'CLEAR ANYWAY') + '</button><button type="button" class="bb sm refit-sel-act">KEEP IT</button></div>';
      const [go, keep] = ask.querySelectorAll('button');
      const a = roomAsk;
      go.onclick = () => { if (a.kind === 'furnish') furnishRoom(rm, a.sid, orientEv(), true); else clearRoom(rm, orientEv(), true); };
      keep.onclick = () => { roomAsk = null; sfx('click'); renderSelection(); };
      host.appendChild(ask);
    }
    // FURNISH: every whole-room style the station builder knows, as tiles — one click lays it (one undo)
    if (furnishOpen && !corridor && plain && furnishReady()) {
      const grid = document.createElement('div'); grid.className = 'refit-furnish-grid'; grid.setAttribute('aria-label', 'Furnish this room as');
      for (const sid of RoomStyles.ROOM_ORDER || Object.keys(RoomStyles.ROOMS)) {
        const rec = RoomStyles.ROOMS[sid]; if (!rec) continue;
        const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'refit-furnish-tile'; tile.dataset.style = sid;
        tile.setAttribute('data-tip', styleLabel(sid) + ' — ' + rec.about);
        const art = document.createElement('span'); art.className = 'refit-furnish-art'; tile.appendChild(art);
        const icon = styleIcon(sid), sp = propSpec(icon);
        propArtInto(art, { t: icon, w: sp.w || 1, h: sp.h || 1 });
        const nm = document.createElement('span'); nm.className = 'refit-furnish-name'; nm.textContent = styleLabel(sid); tile.appendChild(nm);
        tile.onclick = () => furnishRoom(rm, sid, orientEv());
        grid.appendChild(tile);
      }
      host.appendChild(grid);
    }
  }
  /* the group's card: up to three of them in the art well, how many and what (and the belts it took), then what a group can do —
     DUPLICATE / COPY / CUT / DELETE (a drag on any of them moves them all — SELECT MOVES, 10-11); a selection that is exactly ONE WHOLE LINE is named for its line and offers
     COPY LINE / DELETE LINE (THE HAND part 2) */
  function renderGroupCard(host, ps) {
    const count = {};
    for (const p of ps) { const l = propLabel(p.t); count[l] = (count[l] || 0) + 1; }
    const kinds = Object.keys(count), bs = beltSel(), nb = bs ? bs.links.length + bs.tiles.length : 0, line = lineSelectionOf(ps);
    const names = kinds.slice(0, 3).map(l => count[l] > 1 ? l + ' ×' + count[l] : l).join(' · ') + (kinds.length > 3 ? ' · +' + (kinds.length - 3) + ' more' : '');
    const beltWord = nb ? nb + (nb === 1 ? ' belt' : ' belts') : '';
    const title = line ? line.name : ps.length ? ps.length + ' SELECTED' : beltWord.toUpperCase() + ' SELECTED';
    // (the card says how a group moves — its MOVE key is gone: SELECT MOVES. A selection of belts alone does not move by a drag)
    const sub = (line ? 'whole line · ' + ps.length + ' pieces' + (beltWord ? ' · ' + beltWord : '') : ps.length ? [names, beltWord].filter(Boolean).join(' · ') : (nb === 1 ? 'the whole belt' : 'each one whole'))
      + (ps.length && pressMovesSelection() ? ' · drag any to move' : '');
    host.innerHTML = '<div class="refit-sel-head"><span class="refit-sel-art is-group" aria-hidden="true"></span><span class="refit-sel-name"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span>'
      + '<button class="bb sm refit-sel-x" type="button" aria-label="Deselect all" data-tip="Let go of all of them · Esc">✕</button></div><div class="refit-selection-actions"></div>';
    const art = host.querySelector('.refit-sel-art');
    ps.slice(0, 3).forEach(p => propArtInto(art, p));
    host.querySelector('.refit-sel-x').onclick = () => { setSelection([]); sfx('click'); };
    const actions = host.querySelector('.refit-selection-actions');
    const key = (label, k, fn, cls) => { const b = document.createElement('button'); b.className = 'bb sm refit-sel-act' + (cls ? ' ' + cls : ''); b.type = 'button'; b.innerHTML = '<span>' + esc(label) + '</span><kbd>' + esc(k) + '</kbd>'; b.onclick = fn; actions.appendChild(b); };
    if (ps.length) {
      key('DUPLICATE', 'Ctrl+D', () => duplicateGroup(orientEv()));
      key(line ? 'COPY LINE' : 'COPY', 'Ctrl+C', () => copySelected(orientEv()));
      key('CUT', 'Ctrl+X', () => cutSelected(orientEv()));
    }
    if (line) key('DELETE LINE', 'Del', () => deleteLine(line.id, orientEv()), 'refit-sel-del');
    else key('DELETE', 'Del', () => deleteGroup(orientEv()), 'refit-sel-del');
  }
  /* THE SIGN EDITOR (2026-10-21) — the words the Commander writes on a board standing on the
     floor. The board MEASURES the words: signtext.js is the one rule that turns text into a size,
     the model stores that size, and the art draws the words onto the board it was given. So the
     editor shows the size the text asks for BEFORE it is set — the answer is never a surprise. */
  function openSignEditor(propId, ev) {
    if (!root || typeof SignText === 'undefined') return;
    const p = station.propById(propId); if (!p || !SignText.isSign(p.t)) return;
    cardCloseAll();
    const g = document.createElement('div');
    g.className = 'refit-guide refit-sign-editor';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ ${esc(propLabel(p.t))} — WORDS</h3>
        <p class="refit-sign-note">The board measures your words: a short label stays a small plate, every extra line makes it taller. <b>Enter</b> starts a new line — a new line is a new paragraph, and paragraphs make the board taller.</p>
        <textarea class="refit-sign-text" rows="3" spellcheck="false" placeholder="YOUR TEXT HERE"></textarea>
        <div class="refit-sign-size" aria-live="polite"></div>
        <div class="refit-actions">
          <button type="button" class="btn-sm" id="sign-clear">CLEAR</button>
          <button type="button" class="btn-sm" id="sign-cancel">CANCEL</button>
          <button type="button" class="btn-sm primary" id="sign-apply">SET WORDS</button>
        </div>
      </div>`;
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const area = g.querySelector('.refit-sign-text'), size = g.querySelector('.refit-sign-size');
    area.value = String(p.text || '');
    const measure = () => { const b = SignText.box(area.value, p.t); size.textContent = b.w + ' × ' + b.h + ' TILES'; };
    area.addEventListener('input', measure);
    measure();
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    const apply = text => {
      const b = SignText.box(text, p.t);
      const res = station.setPropText(p.id, text, b);
      if (res && res.ok) { sfx('click'); flashTip(ev, 'words set · the board is now ' + res.w + ' × ' + res.h, true); closeP(); renderSelection(); }
      else { sfx('bad'); flashTip(ev, (res && res.msg) || 'the board does not fit where it stands', false); }
    };
    g.querySelector('#sign-apply').onclick = () => apply(area.value);
    g.querySelector('#sign-clear').onclick = () => { area.value = ''; apply(''); };
    g.querySelector('#sign-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    setTimeout(() => { try { area.focus(); area.select(); } catch (_) {} }, 30);
  }
  const isSignProp = t => typeof SignText !== 'undefined' && SignText.isSign(t);

  function configureProp(p, ev) {
    if (!p) return;
    const t = p.t;
    if (WORKSTATION_TYPES[t]) return openWorkstationPicker(p.id, ev);
    if (t === 'bay') return openStepCard(p.id, ev);   // the per-dock STEP EDITOR (step + agent + job brief — one card)
    // routes are edited in the docked Workflow panel like every other machine (2026-09-27 audit P4); the modal stays as the fallback
    if (t === 'filter') return typeof WorkflowPanel !== 'undefined' ? openFlowCard(p.id) : openJunctionEditor(p.id, ev);
    if (t === 'airlock') return openDoorPicker(p.id, ev);
    if (t === 'connector_portal') return openConnectorEditor(p.id, ev);
    if (t === 'plugin_terminal') return openPluginBinder(p.id, ev);
    if (isSignProp(t)) return openSignEditor(p.id, ev);   // a SIGN carries words, not settings (sign editor)
    if (t === 'intake' || t === 'outbox' || t === 'merger' || t === 'splitter' || t === 'joiner' || t === 'loop') return openFlowCard(p.id);
    // no config surface: answer the click honestly instead of doing nothing
    const sp = propSpec(t);
    renderEquipmentInfo(t, p);
    flashTip(ev, ((sp.label || t) + '').toUpperCase() + ' — drag it to move it · DELETE removes it (its card above)', true);
  }
  /* the belt tile a junction dropped NEXT to a belt snaps onto (orthogonal neighbours first, then diagonals) — or null. ONE rule for the
     click (commitPropStamp) and its hover ghost (repair 2026-10-11): the ghost used to judge the hover tile as bare floor and say
     green CLICK TO PLACE while the click snapped onto a belt the model then refused, or landed the piece on another tile */
  const SNAP_JUNCTIONS = { filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 };
  function junctionSnap(t, px, py) {
    if (!SNAP_JUNCTIONS[t] || station.beltAt(px, py)) return null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) if (station.beltAt(px + dx, py + dy)) return { x: px + dx, y: py + dy };
    return null;
  }
  const openPropEditor = (id, t, ev) => { const p = station && station.propById(id); if (p) configureProp(p, ev); };
  const PROP_EDITABLE = { bay: 1, filter: 1, merger: 1, splitter: 1, joiner: 1, loop: 1, airlock: 1, connector_portal: 1, plugin_terminal: 1, intake: 1, outbox: 1 };   // merger/splitter = flow card only (no config)
  const isEditableProp = t => !!PROP_EDITABLE[t] || !!WORKSTATION_TYPES[t];   // a workstation binds an agent + opens its picker on place/click
  function beltUnderFoot(t, x, y, size) {
    if (!CONNECT_TYPES[t] || JUNCTION_TAG_TYPES[t] || !linkedFloor()) return null;
    const tiles = new Set();
    for (let yy=y; yy<y+size.h; yy++) for(let xx=x; xx<x+size.w; xx++) if(station.beltAt(xx,yy)) tiles.add(xx+','+yy);
    if (!tiles.size) return null;
    const hits = linksMemoed().filter(l => (l.path||[]).some(q => tiles.has(q.x+','+q.y)));
    const link = hits.length === 1 && hits[0].from.prop && hits[0].to.prop ? hits[0] : null;
    const v = t === 'bay' && link && station.canInsertBayBetween ? station.canInsertBayBetween(link.from.prop,link.to.prop,{w:size.w,h:size.h,block:true}) : {ok:false,short:'A BELT RUNS HERE',msg:'Drop it beside the belt; a BAY can insert into one clear connection.'};
    return {link,v};
  }
  // a BAY dropped on a belt lands where insertBayBetween puts it (the model's own dry run — canInsertBayBetween's x, y), never at
  // the pointer: the ghost, its art and the landing flash stand THERE (final floor lane M4 — preview == commit)
  const landRect = (foot, rect, s) => (foot && foot.v && foot.v.ok && foot.v.x != null) ? { x1: foot.v.x, y1: foot.v.y, x2: foot.v.x + s.w - 1, y2: foot.v.y + s.h - 1 } : rect;
  function commitPropStamp(d, ev) {
    // CLICK-ON-MACHINE WINS: a click (no drag) on ANY existing prop inspects it instead of attempting
    // a placement on top of it — placement happens only on clear deck. (The old rule only caught a
    // same-type editable prop, so clicking a bay with a desk armed silently tried an invalid place —
    // the exact "it believes I'm trying to place something" complaint.)
    if (!d.moved) {
      const exist = station.propAt(d.cur.tx, d.cur.ty);
      const ep = exist && station.propById(exist);
      if (ep) { onInspect(ep, ev); return; }
    }
    const row = rowSpots(d);
    if (row) return commitRow(row, ev);
    const s = propBox(propType, propFacing(propType));   // the TURNED box, not the catalog's
    // a SIGN starts as the EMPTY board: its size is the engine's answer for no words yet, and it
    // grows the moment the Commander writes on it. (The catalog row already says that; this keeps
    // the two from drifting apart.) The guard is inline on purpose: this function is also read
    // OUT of this file by the headless tests, which run it without the page's globals.
    if (typeof SignText !== 'undefined' && SignText.isSign(propType)) { const b = SignText.box('', propType); s.w = b.w; s.h = b.h; }
    let px = d.cur.tx, py = d.cur.ty;
    // JUNCTION SNAP (connect-mode UX): a filter/splitter/merger only works ON a line — if it's dropped
    // NEXT to one, snap it onto the nearest belt tile instead of leaving an inert junction (the exact
    // silent failure of the 2026-07-05 playtest). Dropped ON a belt already? Unchanged. (junctionSnap — the hover ghost asks the same)
    const snapped = junctionSnap(propType, px, py);
    if (snapped) { px = snapped.x; py = snapped.y; flashTip(ev, 'snapped onto the line', true); }
    const placement = { t: propType, x: px, y: py, w: s.w, h: s.h, block: propSpec(propType).blocks !== false };
    const pr = propFacing(propType), pm = propFlipOn(propType);
    if (pr) placement.r = pr;                            // orientation rides the placement (omitted when south)
    if (pm) placement.m = 1;
    if (propType === 'airlock') placement.door = 'closed';   // a fresh airlock seals its room (then click to cycle)
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(propType) : null;
    const owner = WORKSTATION_TYPES[propType] ? deskOwner : null;   // PLACE ITS DESK: this desk is that agent's, and their only one
    if (owner) placement.agentId = owner;
    /* THE HAND carries what the pipette picked up: a junction's passes / verdict / wait (through the model's own sanitizer), and a
       BAY's crew (only an agent this station has), role, brief and hand-off — all in ONE undo with the piece itself */
    const held = hand && hand.t === propType ? hand : null;
    if (held && held.cfg) for (const k of HAND_CFG_KEYS) if (held.cfg[k] != null) placement[k] = held.cfg[k];
    // a SIGN placed from the hand carries its WORDS — so it must also carry the size those words
    // ask for, or the copy would be a board with text spilling over its frame.
    if (typeof SignText !== 'undefined' && SignText.isSign(propType) && placement.text) {
      const b = SignText.box(placement.text, propType);
      placement.w = b.w; placement.h = b.h; s.w = b.w; s.h = b.h;
    }
    if (held && propType === 'bay' && agentHere(held.agentId)) placement.agentId = held.agentId;
    const bayExtras = held && propType === 'bay' && (held.role || held.brief || held.hands);
    /* A JUNCTION ON A BELT goes through the model's junctionOnBelt (THE HAND, 2026-10-10): never on a belt's first or last tile
       (that took the line apart — ORPHAN_SOURCE), never touching another belt, and a FILTER's EVERYTHING ELSE / a LOOP's DONE lane
       is the lane the belt already runs on, so the line keeps flowing (a filter dropped bare was a FILTER_NO_DEFAULT finding). */
    const onBelt = JUNCTION_TAG_TYPES[propType] && station.beltAt(px, py) && linkedFloor() && typeof station.junctionOnBelt === 'function';
    const foot = beltUnderFoot(propType,px,py,s);
    const res = foot ? (foot.v.ok ? station.transact(() => {
      const r = station.insertBayBetween(foot.link.from.prop,foot.link.to.prop,{w:s.w,h:s.h,block:true,role:held&&held.role});
      if (r && r.ok && held) { if(agentHere(held.agentId)) station.assignPropAgent(r.id,held.agentId); if(held.brief) station.setPropBrief(r.id,held.brief); if(held.hands) station.setPropHands(r.id,held.hands); }
      return r;
    },'BAY') : foot.v) : owner
      ? addOwnedDesk(placement, owner)
      : onBelt ? station.junctionOnBelt(px, py, propType, { cfg: held && held.cfg })
      : bayExtras ? station.transact(() => {
          const a = station.addProp(placement); if (!a || !a.ok) return a;
          if (held.role) station.setPropRole(a.id, held.role);
          if (held.brief) station.setPropBrief(a.id, held.brief);
          if (held.hands) station.setPropHands(a.id, held.hands);
          return a;
        }, propLabel(propType))
      : station.addProp(placement);
    if (onBelt && res && !res.ok) res.msg = res.msg || 'that tile will not take it';
    if (res && !res.ok) res.msg = placementReason({v:res,rects:[{x1:px,y1:py,x2:px+s.w-1,y2:py+s.h-1}]});
    if (foot && res && res.ok && res.x != null) { px = res.x; py = res.y; }   // an inserted BAY flashes where it LANDED (final floor lane M4)
    if (res && res.ok) {
      pushFlash([{ x1: px, y1: py, x2: px + s.w - 1, y2: py + s.h - 1 }], false);
      landProps([res.id]);
      // a prop just landed → resolve the quest generators + fold NOW, so a station gap this placement closes
      // celebrates on its own edge (fast back-to-back placements can't coalesce it away on the 1s tick).
      if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
      if (grant) sfx('chime');   // a capability just came online — a brighter note than the plain placement click
      // first-touch coachmark (tutorial.js): a portal teaches "live tools", any other gear teaches "props are
      // permissions". WORKFLOW props coach even though they're editable (their editor opens too) — otherwise
      // the belt-teach chain coaches never fire at all (editable placements skipped this hook entirely).
      if (typeof Tutorial !== 'undefined') {
        if (propType === 'connector_portal') { if (Tutorial.onConnectorPlaced) Tutorial.onConnectorPlaced(); }
        else if ((!isEditableProp(propType) || CONNECT_TYPES[propType]) && Tutorial.onPropPlaced) Tutorial.onPropPlaced(propType);
      }
      // PLACEMENT FLOW (2026-08-10, Andrew's order): a prop stamp KEEPS the tool and the pick
      // armed — dropping to SELECT here threw the user out of the prop drawer after EVERY
      // placement, so furnishing a room meant a re-pick per prop. Double-stamping on top of the
      // fresh prop can't happen (CLICK-ON-MACHINE WINS inspects it; occupied tiles fail red).
      // ESC / right-click still drops the tool; rooms and blueprints keep their one-shot flow.
      // Configuration is a separate, explicit click on the placed object.
    }
    // a SIGN is placed empty and asks for its words right away: the board is nothing but its text,
    // so the editor opens the moment it lands (the same beat as a desk asking who sits there).
    if (res && res.ok && typeof SignText !== 'undefined' && SignText.isSign(propType)) { selectedPropId = res.id; renderSelection(); openSignEditor(res.id, ev); }
    if (res && res.ok) renderEquipmentInfo(propType);
    if (res && res.ok && held && held.newLine) {   // NEW LINE (startNewLine): one INBOX, where they clicked — then the hand's way on
      setHand(null, { silent: true });
      return feedback(res, ev, 'INBOX PLACED · DRAG FROM IT TO LAY YOUR LINE');
    }
    if (res && res.ok && WORKSTATION_TYPES[propType]) {
      if (owner) { deskOwner = null; setHint(); }   // the next desk dropped is nobody's until picked
      selectedPropId = res.id; renderSelection();   // the tool stays armed; the new desk's card asks who sits there
      return feedback(res, ev, owner ? (agentLabel(owner) + '’s desk · they sit here now') : 'desk placed · pick who sits here');
    }
    if (onBelt) return feedback(res, ev, propLabel(propType) + ' PUT ON THE LINE' + (propType === 'filter' ? ' · EVERYTHING ELSE KEEPS THIS LANE' : propType === 'loop' ? ' · DONE KEEPS THIS LANE — BELT ITS BACK LANE TO AN EARLIER BAY' : ''));
    feedback(res, ev, grant ? ('PLACED · ' + grant + ' equipment') : ('placed ' + ((typeof PropSprites !== 'undefined' && PropSprites.isUserProp && PropSprites.isUserProp(propType)) ? String((PropSprites.spec(propType) || {}).label || 'made prop').toLowerCase() : propType)));   // a made prop's id is internal; say its name
  }
  /* DRAG TO LAY A ROW (2026-10-01 build-mode upgrade). With a piece of furniture armed, a drag lays copies from where you pressed
     to where you let go — along the longer axis, one every footprint — so a row of plants or a line of chairs is one gesture and
     one UNDO; a spot that is blocked is skipped (its ghost showed red first). Machines and capability gear still place one at a
     time — each of those is a capability with its own setup. A drag under ~a third of a tile on screen is a click, not a row. */
  function rowable(t) {
    return !isWorkflowType(t) && t !== 'airlock' && ((typeof PropSprites === 'undefined' || !PropSprites.spec) || (PropSprites.spec(t) || {}).tier !== 'functional')
      && !(typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp && WorldModel.grantLabelForProp(t));
  }
  let rowMemo = null;
  function rowSpots(d) {
    if (!d || !d.moved || d.cx == null || !rowable(propType)) return null;
    if (Math.hypot(lastClient.x - d.cx, lastClient.y - d.cy) < 12) return null;
    const facing = propFacing(propType), key = [geoVer, propType, facing, d.start.tx, d.start.ty, d.cur.tx, d.cur.ty].join('|');
    if (rowMemo && rowMemo.key === key) return rowMemo.spots;
    const s = propBox(propType, facing), dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty, across = Math.abs(dx) >= Math.abs(dy);
    const step = across ? s.w : s.h, sign = (across ? dx : dy) < 0 ? -1 : 1, n = Math.min(40, Math.floor(Math.abs(across ? dx : dy) / step) + 1);
    let spots = null;
    if (n >= 2) {
      spots = [];
      for (let k = 0; k < n; k++) {
        const x = d.start.tx + (across ? sign * k * step : 0), y = d.start.ty + (across ? 0 : sign * k * step);
        spots.push({ x, y, w: s.w, h: s.h, v: station.canPlaceProp(propType, x, y, s.w, s.h) });
      }
    }
    rowMemo = { key, spots };
    return spots;
  }
  function commitRow(row, ev) {
    const pr = propFacing(propType), pm = propFlipOn(propType), block = propSpec(propType).blocks !== false, made = [], laid = [];
    const res = station.transact(() => {
      for (const r of row) {
        const placement = { t: propType, x: r.x, y: r.y, w: r.w, h: r.h, block };
        if (pr) placement.r = pr;
        if (pm) placement.m = 1;
        const a = station.addProp(placement);
        if (a && a.ok) { made.push(a.id); laid.push({ x1: r.x, y1: r.y, x2: r.x + r.w - 1, y2: r.y + r.h - 1 }); }
      }
      return made.length ? { ok: true } : { ok: false, msg: 'every spot on that row is taken — drag along clear floor' };
    });
    if (res && res.ok) {
      pushFlash(laid, false);
      landProps(made, 45);   // they drop in down the row, in the order it was dragged
      if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
      if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced(propType);
      renderEquipmentInfo(propType);
    }
    const skipped = row.length - made.length;
    feedback(res, ev, 'laid a row of ' + made.length + (skipped ? ' · ' + skipped + ' taken spot' + (skipped === 1 ? '' : 's') + ' skipped' : '') + ' · one Undo takes the row back');
  }
  // a row in hand: every spot's art where it will land (a taken one red and faint), and how many the release will lay
  function drawRowGhost(t, now, g) {
    const ok = g.row.filter(r => r.v && r.v.ok), pr = propFacing(propType), pm = propFlipOn(propType);
    ctx.save(); PropSprites.setCtx(ctx); PropSprites.setNow(now);
    try {
      for (const r of g.row) {
        ctx.globalAlpha = r.v && r.v.ok ? 0.62 : 0.22;
        PropSprites.draw({ t: propType, x: r.x, y: r.y, w: r.w, h: r.h, r: pr, m: pm }, false);
      }
    } finally { ctx.restore(); }
    ctx.lineWidth = 1.5 / zoom;
    for (const r of g.row) {
      const good = r.v && r.v.ok, X = r.x * t, Y = r.y * t, W = r.w * t, H = r.h * t;
      ctx.fillStyle = good ? 'rgba(80,255,140,0.12)' : 'rgba(255,90,80,0.16)'; ctx.fillRect(X, Y, W, H);
      ctx.strokeStyle = good ? 'rgba(120,255,170,0.9)' : 'rgba(255,120,110,0.9)'; ctx.strokeRect(X + 0.5 / zoom, Y + 0.5 / zoom, W - 1 / zoom, H - 1 / zoom);
    }
    let bb = g.rects[0];
    for (const r of g.rects) bb = { x1: Math.min(bb.x1, r.x1), y1: Math.min(bb.y1, r.y1), x2: Math.max(bb.x2, r.x2), y2: Math.max(bb.y2, r.y2) };
    const lines = ['ROW OF ' + g.row.length + ' · ' + propLabel(propType)];
    lines.push(!ok.length ? 'EVERY SPOT IS TAKEN' : ok.length < g.row.length ? 'RELEASE TO LAY ' + ok.length + ' · ' + (g.row.length - ok.length) + ' TAKEN' : 'RELEASE TO LAY ALL ' + ok.length);
    ghostBadge(t, lines, ok.length > 0, bb);
  }
  function commitBeltRun(d, ev) {
    // CLICK-ON-MACHINE WINS: connectable machines were consumed by the connect flow in onDown; a
    // plain click on any OTHER machine (a desk, decor) inspects it instead of a 1-tile invalid run.
    if (!d.moved) {
      const exist = station.propAt(d.cur.tx, d.cur.ty);
      const ep = exist && station.propById(exist);
      if (ep) { onInspect(ep, ev); return; }
    }
    const res = station.placeBeltRun(d.start, d.cur);
    if (res && res.ok && res.count) {
      pushFlash([beltRunBox(d.start, d.cur)], false);
      if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();   // first-touch coachmark: belts + ▸ PREVIEW
    }
    feedback(res, ev, res && res.dir ? ('belt → ' + res.dir) : 'belt');
  }
  function commitPropMove(d, ev) {
    let dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty;
    if (!dx && !dy) { hideTip(); return; }
    // a MOVE is only ever a move: an OUTBOX aimed at another line's INBOX is THE HAND's SEND TO (selectedDragAims / planHandGesture —
    // its ghost, its commit); the old propmove SEND TO here could only be reached by Shift-moving onto an INBOX and letting Shift go
    // before the release, and then sent where its own ghost had shown a refused move (wave 2, build-13)
    const mp = station.propById(d.propId);
    // belts never ride along with a machine: say so at the drop (the ghost already warned amber)
    const left = mp ? beltsLeftBehind(mp, mp.x + dx, mp.y + dy) : 0;
    // (a SELECTED conveyor machine let go on another machine never lands here: that drag is THE HAND's — selectedDragAims)
    const moved = station.moveProp(d.propId, dx, dy);
    feedback(moved, ev, moveMsg(moved, left, 'relocated'));
    // the piece it moved is THE selection now (a press on an unselected chair selects + moves it — never leaves a group card up)
    if(moved && moved.ok){if(selectedPropId!==d.propId||groupIds.length||selectedRoomId)setSelection([d.propId]);else renderSelection();landProps([d.propId]);}
  }
  function commitPaint(d, ev) {
    // WALLS are a whole-room surface — there's no per-tile wall, so a drag means the same thing
    // as a click here rather than silently doing nothing.
    if (paintTarget === 'walls') {
      feedback(station.setWalls(d.roomId, { style: wallStyle, mat: wallMat }), ev, 'walls clad');
      return;
    }
    // the SHELL is a whole-room surface too — there is no per-tile exterior
    if (paintTarget === 'hull') {
      feedback(station.setHull(d.roomId, { style: hullStyle, mat: hullMat }), ev, 'shell re-clad');
      return;
    }
    if (d.moved) {
      const tiles = [...d.cells].map(k => { const p = k.split(','); return [+p[0], +p[1]]; });
      feedback(station.paintTiles(d.roomId, tiles, style), ev, 'painted');
    } else {
      // a plain click LAYS THE WHOLE DECK — material and hue together, in one undo slot, so
      // "undo" reverses the deck the Commander just saw laid rather than half of it.
      feedback(station.setDeck(d.roomId, { style, mat }), ev, 'deck laid');
    }
  }
  function commitReclaim(d, ev) {   // DELETE (tool id stays `reclaim`)
    // DRAG across tiles → clear every BELT crossed in ONE undo slot. A drag never removes rooms or
    // props (only single clicks do), so you can wipe a lane without fear of nuking the room under it.
    if (d.moved && d.cells) {
      const tiles = [...d.cells].map(k => { const p = k.split(','); return [+p[0], +p[1]]; }).filter(([x, y]) => station.beltAt(x, y));
      if (!tiles.length) { flashTip(ev, 'drag along a belt to clear it'); sfx('bad'); return; }
      const res = station.removeBelts(tiles);
      if (res && res.ok) { pushFlash(tiles.map(([x, y]) => ({ x1: x, y1: y, x2: x, y2: y })), true); flashUndo(); flashTip(ev, res.count + (res.count === 1 ? ' belt' : ' belts') + ' removed — UNDO to restore', true); sfx('click'); }
      else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
      return;
    }
    const pid = station.propAt(d.cur.tx, d.cur.ty);   // props sit on top — reclaim them first
    if (pid) {
      const p = station.propById(pid), was = p && Object.assign({}, p);
      if(warnSendCuts([pid],ev)) return;
      const res = station.removeProp(pid);
      if (res && res.ok) { if (p) pushFlash([{ x1: p.x, y1: p.y, x2: p.x + p.w - 1, y2: p.y + p.h - 1 }], true); vanishProp(was); flashUndo(); flashTip(ev, 'deleted — UNDO to restore', true); sfx('click'); }
      else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
      return;
    }
    if (station.beltAt(d.cur.tx, d.cur.ty)) {   // a belt tile sits on the floor, under props
      const res = station.removeBelt(d.cur.tx, d.cur.ty);
      if (res && res.ok) { pushFlash([{ x1: d.cur.tx, y1: d.cur.ty, x2: d.cur.tx, y2: d.cur.ty }], true); flashUndo(); flashTip(ev, 'belt removed — UNDO to restore', true); sfx('click'); }
      else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
      return;
    }
    const id = station.roomAt(d.cur.tx, d.cur.ty);
    if (!id) return;
    doDeleteRoom(id, ev);   // ONE room-removal path, shared with the room card's DELETE
  }
  /* ---------- DUPE tool: copy a room or prop, then stamp repeats — the symmetry workflow.
     Props copy their type/footprint + carried config (filter routes, airlock seal) but NEVER an
     agent/connector binding: crewing a bay is a deliberate choice (one agent may crew many — 2026-09-22) and a portal bind is a
     live server relationship, not geometry. Rooms copy their full multi-rect shape + kind + deck style.
     (THE HAND part 2, 2026-10-11 — Andrew approved copying a line WITH its crew, in his prototype: a conveyor piece, a group or a
     whole line is a CLIP instead — dupe.type 'lines', see copyClip — whose BAYs keep their crew when that agent is on this
     station. A lone piece of furniture is still this pickup, and still never carries a binding.) */
  function pickupDupe(w, ev, pickedId) {
    const pid = pickedId || propAtEvent(ev);
    if (pid) {
      const p = station.propById(pid);
      const s = propSpec(p.t);
      dupe = { type: 'prop', t: p.t, w: p.w || 1, h: p.h || 1, block: s.blocks !== false, cfg: {},
               rects: [{ x1: 0, y1: 0, x2: (p.w || 1) - 1, y2: (p.h || 1) - 1 }], label: (s.label || p.t).toUpperCase() };
      // orientation copies with the prop (dupe.w/h above are already its effective box) — stamping a
      // row of chairs all aimed the same way is the whole point of the symmetry workflow.
      if (p.r) dupe.cfg.r = p.r;
      if (p.m) dupe.cfg.m = 1;
      if (p.routes && typeof p.routes === 'object') dupe.cfg.routes = Object.assign({}, p.routes);
      if (p.def) dupe.cfg.def = p.def;
      if (p.door) dupe.cfg.door = p.door;   // (a merger's legacy bufferSize is NOT copied — it configures nothing)
    } else {
      const rid = station.roomAt(w.tx, w.ty);
      const rm = rid && station.roomById(rid);
      if (!rm) { flashTip(ev, 'nothing to copy here — click a room or prop', false); sfx('bad'); return; }
      let mx = Infinity, my = Infinity;
      for (const r of rm.rects) { if (r.x1 < mx) mx = r.x1; if (r.y1 < my) my = r.y1; }
      dupe = { type: 'room', roomKind: rm.kind, floorStyle: rm.floorStyle, label: (rm.name || rm.kind).toUpperCase(),
               rects: rm.rects.map(r => ({ x1: r.x1 - mx, y1: r.y1 - my, x2: r.x2 - mx, y2: r.y2 - my })) };
    }
    sfx('click');
    lastCopy = dupe;
    flashTip(ev, 'COPIED ' + dupe.label + ' — click to stamp · right-click to drop', true);
    setHint('holding ' + dupe.label + ' — click to stamp copies · right-click / Esc to drop');
  }
  function dupeRectsAt(tx, ty) { return dupe.rects.map(r => ({ x1: r.x1 + tx, y1: r.y1 + ty, x2: r.x2 + tx, y2: r.y2 + ty })); }
  function stampDupe(w, ev) {
    if (dupe.type === 'lines') return pasteClipAt(w, ev);   // THE HAND part 2: lay the clip (one undo) — it stays in hand
    if (dupe.type === 'prop') {
      const placement = Object.assign({ t: dupe.t, x: w.tx, y: w.ty, w: dupe.w, h: dupe.h, block: dupe.block }, dupe.cfg);
      const res = station.addProp(placement);
      if (res && res.ok) {
        pushFlash(dupeRectsAt(w.tx, w.ty), false);
        landProps([res.id]);
        if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
        const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(dupe.t) : null;
        if (grant) sfx('chime');
        if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced(dupe.t);
      }
      feedback(res, ev, 'copy placed — click again for another');
    } else {
      const res = station.addRoom({ kind: dupe.roomKind, rects: dupeRectsAt(w.tx, w.ty), floorStyle: dupe.floorStyle });
      if (res && res.ok) pushFlash(dupeRectsAt(w.tx, w.ty), false);
      feedback(res, ev, 'copy placed — click again for another');
    }
  }
  // validate the armed copy at a tile (the ghost's green/red) — same checks a hand placement runs
  function dupeGhost(tx, ty) {
    if (dupe.type === 'lines') return clipGhost(tx, ty);   // THE HAND part 2: a CLIP of floor (its machines and belts) in hand
    const rects = dupeRectsAt(tx, ty);
    const v = dupe.type === 'prop'
      ? station.canPlaceProp(dupe.t, tx, ty, dupe.w, dupe.h)
      : (dupe.roomKind === 'corridor' ? station.canPlaceHallway(rects) : station.canPlaceRoom(rects, dupe.roomKind));
    return { rects, v, kind: 'dupe' };
  }

  /* ---------- THE HAND: the drag gestures (2026-10-10) ----------
     handbelt   — a WORKFLOW machine dragged (Shift up). Let go on: a machine → connect (a BAY or INBOX that already hands work on
                  RE-ROUTES its one exit instead); an OUTBOX onto another line's INBOX → SEND TO (only when the station can —
                  station.setSendTo, feature-detected); a belt → MERGE (a MERGER lands on that tile); empty floor → the dock asks
                  PICK WHAT GOES HERE, listing only what fits there.
     handbranch — a belt dragged from its middle: a SPLITTER lands where it was pressed, and the new belt goes where you let go
                  (a machine, another belt — a MERGER there too — or empty floor and the same picker).
     Each is the model's own planner asked through a pure preview while you drag (memoized per edit, tile and corner — nothing
     is written until you let go, H9) and ONE transact when you do. The reason rides the pointer through the one-voice arbiter. */
  const HAND_PLAN_MODES = { handbelt: 1, handbranch: 1, beltreshape: 1 };
  const beltSource = id => { const p = id && station.propById(id); return !!(p && CONNECT_TYPES[p.t]); };
  const isConveyorPiece = p => !!(p && CONNECT_TYPES[p.t]);
  /* a drag of the SELECTED piece (onMove — ONE GESTURE, THE TARGET DECIDES): does the pointer stand on a target THE HAND takes?
     Only for a lone conveyor machine (never a group, never furniture, never with Shift held). ANOTHER conveyor machine: always (a
     move there could only overlap it). A belt tile: where the hand would MERGE into it (green) — except a 1x1 junction: its move onto
     another line's belt is refused by moveProp (ON_BELT — it would take that line), so the plain MOVE ghost shows that reason.
     Anything else — open floor, its own footprint — is the MOVE. */
  function selectedDragAims(d, w, shift) {
    if (shift || groupIds.length || !beltSource(d.propId)) return false;
    const A = station.propById(d.propId), tid = station.propAt(w.tx, w.ty), T = tid && station.propById(tid);
    if (!A) return false;
    if (T) return T.id !== A.id && isConveyorPiece(T);
    if (JUNCTION_TAG_TYPES[A.t] || !station.beltAt(w.tx, w.ty)) return false;
    const plan = handPlan({ mode: 'handbelt', propId: A.id, moved: true, cur: { tx: w.tx, ty: w.ty } });   // (the same memo the ghost reads)
    return !!(plan && plan.ok && plan.kind === 'merge');
  }
  let linksVer = 0, linksMemo = null;
  const linksMemoed = () => (linksVer === geoVer && linksMemo) ? linksMemo : (linksVer = geoVer, linksMemo = (station && station.links && station.links()) || []);
  // the ONE exit a BAY or INBOX hands its work on through — a new belt from it re-routes that exit (a junction may have several)
  function soleExitOf(p) {
    if (!p || (p.t !== 'bay' && p.t !== 'intake') || !linkedFloor()) return null;
    const outs = linksMemoed().filter(l => l.from && l.from.prop === p.id);
    return outs.length === 1 ? outs[0] : null;
  }
  const refusalWords = pv => String((pv && (pv.short || NO_ROUTE[pv.error] || pv.msg)) || 'NO CLEAR ROUTE').toUpperCase();
  const mName = id => String(machineName(id)).toUpperCase();
  /* SETTLE (final floor lane M13): a conveyor piece's full MOVE / RESHAPE verdict copies the floor and compiles its route — tens
     of ms each on a big station, and a drag asked it on every tile it crossed (a stall per tile at the 5 fps floor). A tile the
     pointer only CROSSES shows the footprint verdict: red is already the truth there, and a fit is drawn amber CHECKING THE ROUTE
     — never green for what was not judged. Once the pointer RESTS on a tile the full verdict is asked (memoized per edit). The
     release re-judges with the real edit whatever the ghost showed. */
  const SETTLE_MS = 140;
  let settleKey = '', settleAt = 0;
  function settled(key) {
    const now = performance.now();
    if (settleKey !== key) { settleKey = key; settleAt = now; return false; }
    return now - settleAt >= SETTLE_MS;
  }
  const CHECKING_ROUTE = 'CHECKING THE ROUTE';
  let handPvKey = '', handPvMemo = null;
  function handPlan(d, force) {
    if (!d || !d.moved || !station) return null;
    const src = d.mode === 'beltreshape' ? 'l'+d.linkId : d.mode === 'handbranch' ? 'b' + d.from.x + ',' + d.from.y : 'p' + d.propId;
    const k = geoVer + '|' + src + '|' + d.cur.tx + ',' + d.cur.ty + '|' + (flipPref ? 1 : 0);
    if (k === handPvKey) return handPvMemo;
    // a reshape's verdict is a probe copy + a route compile: asked once the pointer rests (or at the release), never per tile crossed
    if (d.mode === 'beltreshape' && !force && !settled('r|' + k)) return { ok: true, checking: true, kind: 'reshape', link: d.linkId, why: CHECKING_ROUTE };
    let plan = null;
    try { plan = planHandGesture(d, d.cur.tx, d.cur.ty); } catch (e) { plan = { ok: false, why: 'THAT DID NOT WORK OUT — ' + String((e && e.message) || e).toUpperCase() }; }
    handPvKey = k; handPvMemo = plan;
    return plan;
  }
  function planHandGesture(d, tx, ty) {
    const o = { flip: flipPref }, tile = { x: tx, y: ty };
    const pid = station.propAt(tx, ty), T = pid && station.propById(pid);
    if(d.mode==='beltreshape'){const pv=station.canReshapeLink(d.linkId,tx,ty,o);return pv.ok?{ok:true,kind:'reshape',link:d.linkId,path:pv.path,why:'RESHAPE BELT THROUGH HERE · R FLIPS THE CORNER'}:{ok:false,why:refusalWords(pv)};}
    if (d.mode === 'handbranch') {
      const F = d.from;
      if (tx === F.x && ty === F.y) return null;   // still on the tile it was pressed on
      const split = { t: 'splitter', x: F.x, y: F.y };
      if (T) {
        if (!isConveyorPiece(T)) return { ok: false, to: T, why: 'BELTS RUN BETWEEN CONVEYOR MACHINES' };
        const pv = station.previewBranch(F, T.id, o);
        return pv.ok ? { ok: true, kind: 'branch', to: T, path: pv.path, junctions: [split], why: 'BRANCH TO ' + mName(T.id) + ' · A SPLITTER GOES HERE' }
          : { ok: false, to: T, junctions: [split], why: refusalWords(pv) };
      }
      const pv = station.previewBranch(F, tile, o);
      if (pv.mode === 'branchmerge') return pv.ok ? { ok: true, kind: 'branchmerge', path: pv.path, junctions: [split, { t: 'merger', x: tx, y: ty }], why: 'BRANCH INTO THIS BELT · A SPLITTER AND A MERGER' }
        : { ok: false, junctions: [split], why: refusalWords(pv) };
      return pv.ok ? { ok: true, kind: 'branchfloor', path: pv.path, junctions: [split], why: 'LET GO TO PICK WHAT GOES HERE' } : { ok: false, junctions: [split], why: refusalWords(pv) };
    }
    const A = station.propById(d.propId);
    if (!A) return null;
    if (T && T.id === A.id) return null;   // still over the machine it left
    const exit = soleExitOf(A);
    if (T) {
      if (!isConveyorPiece(T)) return { ok: false, to: T, why: 'BELTS RUN BETWEEN CONVEYOR MACHINES' };
      if (A.t === 'outbox' && T.t === 'intake' && typeof station.setSendTo === 'function') {
        // the ONE SEND TO verdict (worldmodel sendToRefusal: no line, an OLD BELT to convert, same line, a loop) — the ghost never
        // goes green for a drop setSendTo refuses, and says what the BELT tool and the panel say (an old OUTBOX→INBOX belt reads
        // CONVERT THE OLD BELT TO SEND TO, never "this same line": final floor lane M20)
        const sv = sendToPv(A.id, T.id);
        if (sv && sv.ok === false) return { ok: false, to: T, why: sv.short || String(sv.msg || '').toUpperCase() || 'THAT HAND-OFF CAN’T BE MADE' };
        const same = !sv && lineOfProp(A.id), there = same && lineOfProp(T.id);   // (no verdict at all: the floor's own same-line read)
        if (same && there && same.key === there.key) return { ok: false, to: T, why: 'THAT INBOX STARTS THIS SAME LINE' };
        return { ok: true, kind: 'send', to: T, why: 'SEND EVERY RESULT TO ' + mName(T.id) };
      }
      if (exit && exit.to.prop === T.id) return { ok: false, to: T, why: 'ALREADY CONNECTED' };
      if (exit && T.t !== 'intake' && A.t !== 'outbox') {
        const pv = station.previewRelink(exit.id, T.id, o);
        return pv.ok ? { ok: true, kind: 'reroute', link: exit.id, to: T, path: pv.path, why: 'RE-ROUTE · HAND TO ' + mName(T.id) + ' INSTEAD OF ' + mName(exit.to.prop) }
          : { ok: false, to: T, why: refusalWords(pv) };
      }
      if (linksMemoed().some(l => l.from.prop === A.id && l.to.prop === T.id)) return { ok: false, to: T, why: 'ALREADY CONNECTED' };
      const pv = station.previewBelt(A.id, T.id, o);
      const fed = (T.t === 'bay' || T.t === 'outbox') && linksMemoed().some(l => l.to.prop === T.id);
      return pv.ok ? { ok: true, kind: 'connect', to: T, path: pv.path, why: (fed ? 'JOIN ' + mName(T.id) + '’S INPUT' : 'CONNECT TO ' + mName(T.id)) }
        : { ok: false, to: T, why: refusalWords(pv) };
    }
    if (A.t !== 'outbox' && exit) return { ok: false, why: 'THIS ' + propLabel(A.t) + ' ALREADY HANDS WORK ON — DRAG FROM ITS BELT TO BRANCH IT · CLICK IT FIRST TO MOVE IT' };
    const pv = station.previewBeltTo(A.id, tile, o);
    if (pv.mode === 'merge') return pv.ok ? { ok: true, kind: 'merge', path: pv.path, junctions: [{ t: 'merger', x: tx, y: ty }], why: 'MERGE INTO THIS BELT · A MERGER GOES HERE' } : { ok: false, why: refusalWords(pv) };
    return pv.ok ? { ok: true, kind: 'floor', path: pv.path, why: 'LET GO TO PICK WHAT GOES HERE' } : { ok: false, why: refusalWords(pv) + (!d.sel ? ' · CLICK IT FIRST TO MOVE IT' : '') };
  }
  // R mid-drag: the corner turns the other way (where two shortest routes exist) — the preview re-asks, the commit lays the same
  function flipCorner() {
    flipPref = !flipPref; handPvKey = ''; paintHandKeys(); sfx('tick');
    showTip(flipPref ? 'CORNER FLIPPED' : 'CORNER BACK', true); clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 900);
  }
  const pathRects = path => (path || []).map(q => ({ x1: q.x, y1: q.y, x2: q.x, y2: q.y }));
  function commitHandGesture(d, ev) {
    const plan = handPlan(d, true);   // (the release judges for real, even where the ghost was still CHECKING THE ROUTE)
    hideTip();
    // R flips THIS drag's corner: every way the drag ends consumes it, a refusal and a let-go-where-it-started too (wave 2, build-10 —
    // the next, unrelated drag silently routed the flipped way with CORNER still lit)
    if (!plan) { flipPref = false; paintHandKeys(); return; }                                   // let go where it started: nothing happened
    if (!plan.ok) { sfx('bad'); flashTip(ev, plan.why, false); flipPref = false; paintHandKeys(); return; }
    const o = { flip: flipPref }, tile = { x: d.cur.tx, y: d.cur.ty };
    if (plan.kind === 'floor' || plan.kind === 'branchfloor') { openDropPick(d, plan, tile, ev); flipPref = false; paintHandKeys(); return; }   // (the picker keeps the corner it was shown with)
    let res = null, msg = '';
    if (plan.kind === 'reshape') { res=station.reshapeLink(plan.link,tile.x,tile.y,o); msg='RESHAPED BELT · SAME MACHINES · CTRL+Z'; }
    else if (plan.kind === 'connect') { res = station.connectBelt(d.propId, plan.to.id, o); msg = 'CONNECTED TO ' + mName(plan.to.id) + (res && res.count ? ' · ' + res.count + ' BELTS' : ''); }
    else if (plan.kind === 'reroute') { res = station.relinkTo(plan.link, plan.to.id, o); msg = 'RE-ROUTED · NOW HANDS TO ' + mName(plan.to.id); }
    else if (plan.kind === 'send') { res = station.setSendTo(d.propId, plan.to.id); msg = 'SENDS EVERY RESULT TO ' + mName(plan.to.id); }
    else if (plan.kind === 'merge') { res = station.mergeBelt(d.propId, tile, o); msg = 'MERGED · A MERGER JOINS THE TWO BELTS'; }
    else if (plan.kind === 'branch') { res = station.branchBelt(d.from, plan.to.id, o); msg = 'BRANCHED · A SPLITTER NOW FEEDS ' + mName(plan.to.id); }
    else if (plan.kind === 'branchmerge') { res = station.branchBelt(d.from, tile, o); msg = 'BRANCHED INTO THE OTHER BELT'; }
    if (res && res.ok) {
      sfx('chime'); flashTip(ev, msg, true);
      pushFlash(pathRects(plan.path).concat((plan.junctions || []).map(j => ({ x1: j.x, y1: j.y, x2: j.x, y2: j.y }))), false);
      const made = [res.id, res.made].filter(id => id && station.propById(id) && plan.kind !== 'reroute');
      if (made.length && plan.kind !== 'connect' && plan.kind !== 'send') landProps(made, 60);
      if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced && plan.kind !== 'send') Tutorial.onBeltPlaced();
    } else { sfx('bad'); flashTip(ev, String((res && (res.short || res.msg)) || 'that did not go').toUpperCase(), false); }
    flipPref = false; paintHandKeys();   // R flips THIS drag's corner; the next one starts plain (the CORNER key flips the next drag)
  }
  /* PICK WHAT GOES HERE (empty-floor release). The pieces that fit are asked ONCE, now, of a probe copy (station.probeDrop — the
     real edit, thrown away); the bottom dock lists only those (windows dock from the bottom — never a popover at the pointer), a
     pin marks the tile, the ghost belt stays drawn; a pick lays it all as one undo, Esc / right-click / a press elsewhere cancels. */
  const DROP_TYPES = ['bay', 'outbox', 'splitter', 'merger', 'joiner', 'filter', 'loop'];   // an INBOX starts a line: nothing belts into it
  function dropSpec(t) { const s = propSpec(t); return { t, w: s.w || 1, h: s.h || 1, block: s.blocks !== false }; }
  function openDropPick(d, plan, tile, ev) {
    const from = d.mode === 'handbranch' ? { belt: { x: d.from.x, y: d.from.y } } : d.propId;
    let opts = [];
    try { opts = station.probeDrop(from, tile, DROP_TYPES.map(dropSpec), { flip: flipPref }) || []; } catch (e) { opts = []; }
    dropPick = { from, tile, flip: flipPref, path: plan.path || [], junctions: plan.junctions || [], opts };
    sfx(opts.some(q => q.ok) ? 'open' : 'bad');
    toggleKit(false); renderSelection();
    setHint(opts.some(q => q.ok) ? 'PICK WHAT GOES HERE · Esc or right-click cancels' : 'NOTHING FITS THERE · Esc cancels');
  }
  function commitDropPick(t) {
    const dp = dropPick; if (!dp) return;
    const spec = dropSpec(t), at = { clientX: lastClient.x, clientY: lastClient.y };
    const res = dp.from && typeof dp.from === 'object' && dp.from.belt
      ? station.branchBelt(dp.from.belt, dp.tile, { flip: dp.flip, place: spec })
      : station.dropFrom(dp.from, dp.tile, spec, { flip: dp.flip });
    dropPick = null; renderSelection(); setHint();
    if (res && res.ok) {
      const newId = res.made || res.id, np = newId && station.propById(newId);
      sfx('chime'); flashTip(at, propLabel(t) + ' PLACED AND CONNECTED' + (t === 'bay' ? ' · CLICK IT TO CREW IT' : ''), true);
      const laid = newId && (station.links() || []).find(l => l.to && l.to.prop === newId);   // the belt it really got (never the stand-in's route)
      pushFlash(pathRects(laid ? laid.path : dp.path).concat(np ? [{ x1: np.x, y1: np.y, x2: np.x + np.w - 1, y2: np.y + np.h - 1 }] : []), false);
      if (np) landProps([np.id]);
      if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();
    } else { sfx('bad'); flashTip(at, String((res && (res.short || res.msg)) || 'that did not fit').toUpperCase(), false); }
  }
  function renderDropPick(host) {
    const dp = dropPick, fits = dp.opts.filter(q => q.ok), why = (dp.opts.find(q => !q.ok && q.msg) || {}).msg;
    host.innerHTML = '<div class="refit-sel-head refit-droppick-head"><span class="refit-sel-name"><b>PICK WHAT GOES HERE</b><small>'
      + (fits.length ? 'only what fits at the pin · one undo' : 'nothing fits at the pin') + '</small></span>'
      + '<button class="bb sm refit-sel-x" type="button" aria-label="Cancel" data-tip="Cancel · Esc">✕</button></div>'
      + (fits.length ? '<div class="refit-droppick"></div>' : '<p class="refit-droppick-none">' + esc(String(why || 'There is no room for a piece there — let go nearer clear floor.')) + '</p>');
    host.querySelector('.refit-sel-x').onclick = () => { setHand(null); };
    const grid = host.querySelector('.refit-droppick');
    if (grid) for (const q of fits) {
      const c = catalog().find(x => x && x.id === q.t) || { label: q.t };
      const b = document.createElement('button'); b.type = 'button'; b.className = 'refit-hotslot refit-dropslot'; b.dataset.drop = q.t;
      b.dataset.tip = c.label + (PALETTE_PURPOSE[q.t] ? '\n' + PALETTE_PURPOSE[q.t] : '');
      const img = document.createElement('img'); img.alt = ''; img.className = 'refit-hotart'; const url = machineStill(q.t); if (url) img.src = url;
      const nm = document.createElement('span'); nm.className = 'refit-hotname'; nm.textContent = c.label;
      b.append(img, nm); b.onclick = () => commitDropPick(q.t);
      // pointing at a piece shows ITS belt and footprint on the floor (a 2x2 stands where a 1x1's route ended — its belt is a tile shorter)
      const hot = on => { if (dropPick !== dp) return; dp.hot = on ? q.t : (dp.hot === q.t ? null : dp.hot); };
      b.addEventListener('pointerenter', () => hot(true)); b.addEventListener('pointerleave', () => hot(false));
      b.addEventListener('focus', () => hot(true)); b.addEventListener('blur', () => hot(false));
      grid.appendChild(b);
    }
  }
  /* RIGHT-CLICK REMOVES (empty hand): the conveyor piece under the pointer (a 1-in/1-out junction's two belts become one again —
     the floor's own reconcile), or the WHOLE belt under it (its link: every tile no other link rides). One undo; the floor says
     REMOVED · <WHAT> where it went. Furniture and bare floor are not this gesture's (right-click there stays a plain deselect). */
  function removeAt(ev) {
    const w = toWorldTile(ev);
    const pid = propAtEvent(ev) || station.propAt(w.tx, w.ty), p = pid && station.propById(pid);
    if (p && isConveyorPiece(p)) {
      if (warnSendCuts([p.id], ev, null, 'RIGHT-CLICK / REMOVE')) return true;
      const was = Object.assign({}, p), label = propLabel(p.t);
      const res = station.removeProp(p.id);
      if (res && res.ok) {
        pushFlash([{ x1: was.x, y1: was.y, x2: was.x + was.w - 1, y2: was.y + was.h - 1 }], true); vanishProp(was); flashUndo();
        floatAt({ x: was.x + was.w / 2, y: was.y }, 'REMOVED · ' + label + ' · CTRL+Z', 'bad');
        if (selectedPropId === p.id) { selectedPropId = null; renderSelection(); }
      } else { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked', false); }
      return true;
    }
    if (p) return false;
    return removeBeltAt(w.tx,w.ty,ev);
  }
  function removeBeltAt(tx,ty,ev) {
    const w={tx,ty};
    if (!station.beltAt(w.tx, w.ty)) return false;
    /* a tile two CONNECTIONS share (an old save's merged run): never guess which goes (wave 2, build-17 — it took whichever link came
       first and said only REMOVED · BELT). Counted as the belt card counts them, per from ▸ to pair (connsAt): one connection laid twice
       — two links, one pair — is ONE belt and goes whole (wave 2 repair: this counted links, the card pairs, so the card's one key
       refused forever). Two or more: say so — a click opens the card's one-key-per-connection; with the touch REMOVE key armed the tap
       opens that card itself (a tap there only repeated the CLICK IT advice) */
    const conns = linkedFloor() ? connsAt(w.tx, w.ty) : [];
    if (conns.length > 1) {
      if (touchArm === 'remove') { openBeltCard(w.tx, w.ty, ev); return true; }
      sfx('bad'); flashTip(ev, 'THIS TILE CARRIES ' + conns.length + ' BELTS — CLICK IT TO PICK WHICH ONE GOES', false); return true;
    }
    if (conns.length === 1 && conns[0].ids.length > 1) { removeBeltLinks(conns[0].ids, ev); return true; }
    const linked = linkedFloor() && typeof station.removeLinkAt === 'function' ? station.removeLinkAt(w.tx, w.ty) : null;
    const res = linked && linked.ok ? linked : station.removeBelt(w.tx, w.ty);
    if (res && res.ok) {
      pushFlash([{ x1: w.tx, y1: w.ty, x2: w.tx, y2: w.ty }], true); flashUndo(); sfxVanish();
      floatAt({ x: w.tx + 0.5, y: w.ty }, 'REMOVED · ' + (linked && linked.ok ? 'BELT' : 'BELT TILE') + ' · CTRL+Z', 'bad');
    } else { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked', false); }
    return true;
  }
  // the connections riding one belt tile, per from ▸ to pair: [{ from, to, ids }] — what the belt card offers a REMOVE key for and what
  // REMOVE BELT counts (one count for both: wave 2 repair, build-17)
  function connsAt(tx, ty) {
    const byPair = new Map(), out = [];
    for (const l of linksMemoed()) {
      if (!l || !l.from || !l.to || l.from.prop == null || l.to.prop == null || !(l.path || []).some(q => q.x === tx && q.y === ty)) continue;
      const k = l.from.prop + '>' + l.to.prop;
      if (byPair.has(k)) { byPair.get(k).ids.push(l.id); continue; }
      const c = { from: l.from.prop, to: l.to.prop, ids: [l.id] }; byPair.set(k, c); out.push(c);
    }
    return out;
  }
  // the tiles a set of links covers (each once), and those no OTHER link rides — what removing them clears, what the card's key lights
  function linkTiles(ids) {
    const want = new Set(ids || []), all = linksMemoed(), mine = all.filter(l => want.has(l.id));
    const others = new Set(); for (const l of all) if (!want.has(l.id)) for (const q of (l.path || [])) others.add(q.x + ',' + q.y);
    const seen = new Set(), tiles = [];
    for (const l of mine) for (const q of (l.path || [])) { const k = q.x + ',' + q.y; if (!seen.has(k)) { seen.add(k); tiles.push(q); } }
    return { want, mine, tiles, alone: tiles.filter(q => !others.has(q.x + ',' + q.y)) };
  }
  /* which side a connection is on, for two that read the same on a shared tile (wave 2 repair, build-17): where its own belt JOINS the
     run the look-alikes share ('FROM ▴ NORTH'), else where it LEAVES it ('TO ▸ EAST') — read off its path, a place on the floor the
     Commander can see; null when its belt never meets theirs side by side */
  const SIDE_WORD = { '0,-1': '▴ NORTH', '0,1': '▾ SOUTH', '-1,0': '◂ WEST', '1,0': '▸ EAST' };
  function connSide(c, alike) {
    const all = linksMemoed(), theirs = new Set();
    for (const o of alike) for (const l of all) if (o.ids.includes(l.id)) for (const q of (l.path || [])) theirs.add(q.x + ',' + q.y);
    const path = ((all.find(l => l.id === c.ids[0]) || {}).path) || [], on = q => theirs.has(q.x + ',' + q.y);
    const word = (a, b) => SIDE_WORD[(a.x - b.x) + ',' + (a.y - b.y)] || null;
    for (let i = 1; i < path.length; i++) if (on(path[i]) && !on(path[i - 1])) { const w = word(path[i - 1], path[i]); if (w) return 'FROM ' + w; }
    for (let i = path.length - 2; i >= 0; i--) if (on(path[i]) && !on(path[i + 1])) { const w = word(path[i + 1], path[i]); if (w) return 'TO ' + w; }
    return null;
  }
  // the belt card's REMOVE <A ▸ B> on a shared tile: exactly those links, one undo; the float rises over a tile only they rode
  function removeBeltLinks(ids, ev) {
    const { want, mine, tiles, alone } = linkTiles(ids);
    if (!mine.length || typeof station.removeLinks !== 'function') return false;
    const res = station.removeLinks(Array.from(want));
    if (!(res && res.ok)) { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked', false); return false; }
    const at = alone.length ? alone[Math.floor(alone.length / 2)] : tiles[0];
    pushFlash((alone.length ? alone : tiles).map(q => ({ x1: q.x, y1: q.y, x2: q.x, y2: q.y })), true); flashUndo(); sfxVanish();
    if (at) floatAt({ x: at.x + 0.5, y: at.y }, 'REMOVED · BELT · CTRL+Z', 'bad');
    return true;
  }
  // Q: pick up one like the piece under the pointer — its type, settings and crew (an agent this station has) — Q again puts it down
  function pipette(ev, pid) {
    if (hand) { setHand(null); return; }
    const p = pid && station.propById(pid);
    if (!p) { touchArm = null; paintHandKeys(); sfx('bad'); flashTip(ev, 'POINT AT A PIECE — Q PICKS UP ONE LIKE IT', false); return; }
    const h = handFromProp(p);
    setHand(h, { silent: true }); sfx('click');
    flashTip(ev, 'HOLDING · ' + propLabel(p.t) + (h.agentId ? ' · CREWED BY ' + String(agentLabel(h.agentId)).toUpperCase() : '') + (h.cfg ? ' · ITS SETTINGS' : '') + ' — click to place', true);
  }
  /* UNDID · <WHAT> (H6): the model's undo/redo hand back what they took back and where (WorldModel editDiff) — a short float rises
     over those tiles, which flash; a history with nothing to take back says nothing. World tiles, drawn in the 'flashes' layer. */
  const floaters = [];
  const FLOAT_MS = 2200;
  function floatAt(tileCenter, text, tone) { floaters.push({ x: tileCenter.x, y: tileCenter.y, text: String(text).toUpperCase(), tone: tone || 'ok', t0: performance.now() }); if (floaters.length > 6) floaters.shift(); }
  function floatHistory(r, word) {
    if (!r || !r.ok) return;
    const rects = Array.isArray(r.rects) ? r.rects : [];
    let x = null, y = null;
    if (rects.length) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity;
      for (const q of rects) { x1 = Math.min(x1, q.x1); y1 = Math.min(y1, q.y1); x2 = Math.max(x2, q.x2); }
      x = (x1 + x2 + 1) / 2; y = y1;
      pushFlash(rects.slice(0, 60), false);   // what changed lights up (an undo that brings a piece back is not a deletion — never the red)
    } else if (cv) { x = ((cv.width / 2 - panX) / zoom) / T(); y = ((cv.height / 2 - panY) / zoom) / T(); }
    if (word === 'UNDID') sfxVanish(); else sfxLand();
    floaters.length = 0;   // one voice at a time: the history float replaces whatever the floor was last saying (a REMOVED it just took back)
    floatAt({ x, y }, word + ' · ' + (r.label || 'EDIT'), 'note');
  }
  /* every float SPEAKS through the one-voice arbiter (repair 2026-10-11 — refit one-voice law): registered as 'float' (above the hover
     nameplate, below a live gesture's own caption), anchored on the tiles it names — so SELECTED · LINE X never stacks on the hover
     nameplate of the piece under the pointer, and UNDID · BAY never prints over that BAY's name; the arbiter picks one voice */
  function drawFloaters(now, t) {
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i], k = (now - f.t0) / FLOAT_MS;
      if (k >= 1 || f.x == null) { floaters.splice(i, 1); continue; }
      const box = captionBox(f.text, f.x * t, f.y * t - t * 0.4 - k * t * 1.2);
      const top = (viewInsetsFrame().t - panY) / zoom + 4 / zoom;   // kept on the visible glass (a float over the top row ran under the top bar)
      if (box.y < top) box.y = top;
      const col = f.tone === 'bad' ? '#ff8f80' : f.tone === 'note' ? '#f0e6ce' : '#7ee2a8', a = k < 0.75 ? 1 : (1 - k) / 0.25, text = f.text;
      voiceSay('float', { x: f.x * t - t / 2, y: f.y * t, w: t, h: t }, box, c => captionPlate(c, text, box, col, a));
    }
  }

  function feedback(res, ev, okMsg) {
    if (res && res.ok) { sfx('click'); flashTip(ev, okMsg, true); }
    else { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked'); }
  }
  function pushFlash(rects, bad) { flashes.push({ rects: rects.map(r => Object.assign({}, r)), t0: performance.now(), bad: !!bad }); }
  function pushMoves(moves) { flashes.push({ moves: moves.map(m => ({ from: Object.assign({}, m.from), to: Object.assign({}, m.to) })), t0: performance.now() }); }
  function flashUndo() { if (undoBtn) { undoBtn.classList.add('pulse'); setTimeout(() => undoBtn && undoBtn.classList.remove('pulse'), 900); } }

  function onWheel(ev) {
    ev.preventDefault();
    const c = toCanvas(ev), t = T();
    const wx = (c.x - panX) / zoom, wy = (c.y - panY) / zoom;
    const d = clamp(ev.deltaY, -50, 50);   // normalize notch vs trackpad so one mouse click doesn't over-zoom
    zoom = clamp(zoom * Math.exp(-d * 0.0022), MINZ, MAXZ);
    panX = c.x - wx * zoom; panY = c.y - wy * zoom;
  }

  /* ---------- the zoom control (2026-08-07) ----------
     Zoom was wheel-only and said so nowhere but a hint line: a Commander on a trackpad, or one who
     simply never scrolled over the canvas, had no way to find it. – / % / + in the action deck makes
     it a control you can SEE, and the readout doubles as a "you are here" for the camera. Both keep
     the VIEW CENTRE fixed (the wheel anchors on the pointer; a button has no pointer to anchor on,
     and anchoring on the last pointer position would make the floor lurch away from the button). */
  function zoomAboutCentre(next) {
    const ins = viewInsets();
    const cx = ins.l + (cv.width - ins.l) / 2, cy = ins.t + (cv.height - ins.t - ins.b) / 2;
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
    zoom = clamp(next, MINZ, MAXZ);
    panX = cx - wx * zoom; panY = cy - wy * zoom;
  }
  const zoomStep = dir => zoomAboutCentre(zoom * (dir > 0 ? 1.25 : 1 / 1.25));
  const zoomTo = z => zoomAboutCentre(z);

  /* The action deck's subtitle used to be a fixed sentence repeating what the dock already says.
     It now carries the one thing nothing else on screen does: how big the station you are editing
     actually IS. Every number is counted off the model on the frame it is shown — rooms and deck
     tiles from the room rects, machines from the prop list — so it can never claim a station the
     save doesn't hold (truthful telemetry). */
  let statSig = '', zoomSig = '';
  function updateTopReadout() {
    if (!root) return;
    const zt = Math.round(zoom * 50) + '%';   // 100% = zoom 2, the entering default
    if (zt !== zoomSig) {
      zoomSig = zt;
      const zl = root.querySelector('#refit-zlvl');
      if (zl) zl.textContent = zt;
    }
    /* THE CENSUS ONLY MOVES WITH THE FLOOR. The zoom readout above is per-frame (the camera is not
       geometry), but rooms/rects/props cannot change without a station.onChange — and the scan below
       walks every room AND every rect AND the whole prop list. The old throttle compared the finished
       signature, which skipped the DOM write but paid the full walk on every one of 60 frames a
       second. Gate the WALK on geoVer; the signature check still guards the DOM write. */
    if (statVer === geoVer) return;
    const sub = root.querySelector('#refit-sub');
    if (!sub) return;   // DOM not up yet — do NOT bank the version, or the readout never lands
    statVer = geoVer;
    const list = station.rooms();
    let tiles = 0, halls = 0, rooms = 0;
    for (const rm of list) {
      if (rm.kind === 'corridor') halls++; else rooms++;
      for (const r of rm.rects) tiles += (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
    }
    const machines = station.props().length;
    const sig = rooms + '/' + halls + '/' + tiles + '/' + machines;
    if (sig === statSig) return;   // the sub is re-read every frame; only touch the DOM when it moved
    const first = statSig === '';
    statSig = sig;
    const bits = [rooms + (rooms === 1 ? ' ROOM' : ' ROOMS')];
    if (halls) bits.push(halls + (halls === 1 ? ' HALL' : ' HALLS'));
    bits.push(tiles + ' TILES');
    if (machines) bits.push(machines + (machines === 1 ? ' OBJECT' : ' OBJECTS'));
    /* THE STATION'S OWN NAME FOR ITS SIZE. A pure LABEL on a number already shown — no gauge, no
       gate, nothing unlocks at a threshold (sandbox law); crossing one is simply the floor earning
       a bigger word, which is the whole point of building. Announced once, when it happens. */
    const tier = tierFor(tiles);
    if (!first && tier !== lastTier) { sfx('milestone'); announceTier(tier); }
    lastTier = tier;
    sub.innerHTML = '<span class="refit-tier">' + esc(tier) + '</span>' + esc(' · ' + bits.join(' · '));
  }
  // deck tiles → the station's size word. Thresholds are round numbers, not tuned: they exist to
  // give a growing floor a few named landmarks, and every one is reachable from minute one.
  const TIER_STEPS = [[3000, 'CITADEL'], [1200, 'COMPLEX'], [400, 'STATION'], [0, 'OUTPOST']];
  const tierFor = tiles => (TIER_STEPS.find(s => tiles >= s[0]) || TIER_STEPS[TIER_STEPS.length - 1])[1];
  let lastTier = '';
  function announceTier(tier) {
    if (!root) return;
    const el = root.querySelector('.refit-tier');
    const el2 = root.querySelector('.refit-title');
    [el, el2].forEach(n => { if (!n) return; n.classList.remove('refit-levelup'); void n.offsetWidth; n.classList.add('refit-levelup'); });
    // NO StationUI.notify (notification diet): the BUILD MODE title flash + the new tier word ARE the announcement.
  }

  const ESC_EXIT_WINDOW_MS = 2500;
  let escExitArmedAt = 0;   // performance.now() of the bare ESC that armed "press again to leave" (0 = not armed)
  function onKey(ev) {
    const a = ev.target;
    const modal = cardTop();
    // Inputs keep every ordinary editing key, but ESC still belongs to the mounted card so its
    // registered close path can save the field before dismissing it.
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)
      && (!modal || ev.key !== 'Escape')) return;
    /* A MOUNTED CARD OWNS THE KEYBOARD (2026-08-07 conveyor audit). These shortcuts drive the FLOOR, and
       the floor is not what you are looking at while a card is up: with the STEP editor open, `9` armed
       LINES and yanked the camera out from under the card, and Ctrl+Z undid the very stamp that created
       the bay being edited. Only ESC crosses a card — and it closes THAT card (below), never the floor. */
    if (modal && ev.key !== 'Escape') return;
    if (ev.key === ' ' && a && (a.tagName === 'BUTTON' || a.tagName === 'SUMMARY')) return;
    if (ev.key === ' ') { ev.preventDefault(); spaceHeld = true; setCursor(); return; }
    // ALT VIEW while held — and never the browser's menu bar (a bare Alt focuses it in a browser tab); onBlur lets it go
    if (ev.key === 'Alt') { ev.preventDefault(); altHeld = true; return; }
    // Shift over a piece turns the pointer into the move cursor (Shift+drag moves any piece) — and back when it is let go
    // (Shift is still "any other key": it disarms a pending Esc-to-exit first — a Shift+click after one Esc never leaves BUILD MODE)
    if (ev.key === 'Shift') { escExitArmedAt = 0; if (tool === 'select' && !drag && hoverHandle < 0 && cv) cv.style.cursor = cursorFor(true); return; }
    if (ev.key === 'Escape') {
      // close the TOPMOST card through ITS OWN close path (which saves what that card saves — an unsaved
      // job brief / line name / room rename). markSeen() belongs to the first-run card ALONE, and that
      // card's own registered path is what does it: `.refit-guide` is shared by eight cards, so matching
      // on it here is what used to mark the guide seen from a step editor and throw the brief away.
      if (modal) { cardClose(modal); return; }
      const categoryMenu = root.querySelector('.refit-category-menu[open]');
      if (categoryMenu) { categoryMenu.open = false; categoryMenu.querySelector('summary').focus(); return; }
      const details = root.querySelector('.refit-propworkspace.show-details');
      if (details) { const toggle = details.querySelector('.refit-details-toggle'); toggle.click(); toggle.focus(); return; }
      if (!drag && (hand || touchArm || dropPick)) { setHand(null); return; }   // THE HAND: put down what is held (or the unanswered picker)
      if (drag || connectFrom || connectTo || dupe) { selectTool('select'); return; }
      if (selectedPropId || groupIds.length || selectedRoomId) { selectTool('select'); return; }
      if (selBelts) { setSelection([]); return; }   // (a box that took only belts lets go too)
      if (typeof WorkflowPanel !== 'undefined' && WorkflowPanel.isOpen()) { WorkflowPanel.close(); return; }   // the docked panel closes (saving) before BUILD MODE does
      if (tool !== 'select') { deselectTool(); return; }                 // then the armed tool → SELECT
      /* LEAVING IS ITS OWN, EXPLICIT PRESS (2026-09-23 playtest). A bare select-mode ESC used to close BUILD MODE
         outright, so the same key that had just deselected something threw you out of build mode on the next
         tap. Now the first bare ESC only ARMS the exit and says so; a second ESC within the window (or the
         SAVE & EXIT button) leaves. Any card, tool or selection still eats ESC first, exactly as before. */
      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      if (escExitArmedAt && nowMs - escExitArmedAt < ESC_EXIT_WINDOW_MS) { escExitArmedAt = 0; return close(); }
      escExitArmedAt = nowMs || 1;
      showTip('PRESS ESC AGAIN TO SAVE & EXIT', true); clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, ESC_EXIT_WINDOW_MS);
      return;
    }
    escExitArmedAt = 0;   // any other key disarms the pending exit
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      dropPickOff();
      const r = ev.shiftKey ? station.redo() : station.undo();
      sfx(r.ok ? 'click' : 'bad'); floatHistory(r, ev.shiftKey ? 'REDID' : 'UNDID'); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); dropPickOff(); const r = station.redo(); sfx(r.ok ? 'click' : 'bad'); floatHistory(r, 'REDID'); return; }
    if (ev.key === '/') { ev.preventDefault(); buildGroup = 'props'; selectTool('select'); root.querySelector('#refit-propsearch-input')?.focus(); return; }
    if (ev.key === 'f' || ev.key === 'F') { fitCamera(); return; }
    // THE HAND: R mid-drag flips the belt's corner; Q picks up one like the piece under the pointer (Q again puts it down)
    if ((ev.key === 'r' || ev.key === 'R') && drag && HAND_PLAN_MODES[drag.mode]) { ev.preventDefault(); flipCorner(); return; }
    if ((ev.key === 'q' || ev.key === 'Q') && tool === 'select' && !(ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); pipette(orientEv(), hoverPropId); return; }
    // THE HAND part 2: R with a CLIP in hand turns the paste a quarter (Shift+R: back)
    if ((ev.key === 'r' || ev.key === 'R') && tool === 'dupe' && dupe && dupe.type === 'lines' && !(ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); turnClip(ev.shiftKey ? 3 : 1, orientEv()); return; }
    // R/M belong to pending prop placement, or to hovered furniture while browsing.
    // Both are no-ops with a reason on art that cannot turn/flip.
    if (ev.key === 'r' || ev.key === 'R') { ev.preventDefault(); turnUnderCursor(ev.shiftKey ? -1 : 1); return; }
    if (ev.key === 'm' || ev.key === 'M') { ev.preventDefault(); flipUnderCursor(); return; }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A') && tool === 'select') { ev.preventDefault(); selectAllProps(orientEv()); return; }
    // a selected ROOM: Delete twice deletes it (everything on it goes, one Undo brings it back), the arrows nudge it (Shift: five)
    if (selectedRoomId && tool === 'select') {
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelectedRoom(orientEv()); return; }
      const RA = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (RA) { ev.preventDefault(); const n = ev.shiftKey ? 5 : 1; nudgeRoom(RA[0] * n, RA[1] * n, orientEv()); return; }
    }
    // a box that took only BELTS: Delete takes them up (THE HAND part 2)
    if (!selectedPropId && !groupIds.length && selBelts && tool === 'select' && (ev.key === 'Delete' || ev.key === 'Backspace')) { ev.preventDefault(); deleteGroup(orientEv()); return; }
    // EDITOR KEYS on the selected object — or the selected group (MANY AT ONCE); with nothing selected they do nothing, quietly
    if ((selectedPropId || groupIds.length) && tool === 'select') {
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelected(orientEv()); return; }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'd' || ev.key === 'D')) { ev.preventDefault(); duplicateSelected(orientEv()); return; }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C')) { ev.preventDefault(); copySelected(orientEv()); return; }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'x' || ev.key === 'X')) { ev.preventDefault(); cutSelected(orientEv()); return; }   // CUT: copy, then take it up (one undo)
      const ARROW = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (ARROW) { ev.preventDefault(); const n = ev.shiftKey ? 5 : 1; nudgeSelected(ARROW[0] * n, ARROW[1] * n, orientEv()); return; }
    }
    // ...and under an armed tool whose drag on the selection moves it (pressMovesSelection): its card says "arrows nudge" there too
    if ((selectedPropId || groupIds.length) && tool !== 'select' && pressMovesSelection()) {
      const ARROW = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (ARROW) { ev.preventDefault(); const n = ev.shiftKey ? 5 : 1; nudgeSelected(ARROW[0] * n, ARROW[1] * n, orientEv()); return; }
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'v' || ev.key === 'V') && lastCopy) {
      ev.preventDefault();
      const held = lastCopy;
      if (held.type === 'lines') { holdClip(held, orientEv()); return; }   // a CLIP of floor: the paste ghost (R turns it)
      selectTool('dupe', { keepGroup: true, silent: true }); dupe = held; sfx('click');
      flashTip(orientEv(), 'HOLDING ' + held.label + ' — click to place copies · right-click to drop', true);
      setHint('holding ' + held.label + ' — click to stamp copies · right-click / Esc to drop');
      return;
    }
    // THE HOTBAR: while the Conveyors tab is up, 1–8 pick its pieces (the same key again puts it down); other tabs keep the tool keys
    if (buildGroup === 'workflow' && /^[1-8]$/.test(ev.key) && !(ev.ctrlKey || ev.metaKey || ev.altKey)) { toggleHand(HOTBAR[+ev.key - 1]); return; }
    const map = { '0': 'select', '1': 'room', '2': 'hall', '3': 'paint', '5': 'reclaim', '6': 'prop', '7': 'belt', '8': 'dupe', '9': 'line' };   // (4 was MOVE — retired 10-11: SELECT moves; the number stays free)
    if (map[ev.key]) selectTool(map[ev.key]);
  }
  function onKeyUp(ev) { if (ev.key === ' ') { spaceHeld = false; setCursor(); } if (ev.key === 'Alt') { ev.preventDefault(); altHeld = false; } if (ev.key === 'Shift' && tool === 'select' && !drag && hoverHandle < 0 && cv) cv.style.cursor = cursorFor(false); }

  /* ---------- geometry helpers (world tiles) ---------- */
  function norm(a, b) { return { x1: Math.min(a.tx, b.tx), y1: Math.min(a.ty, b.ty), x2: Math.max(a.tx, b.tx), y2: Math.max(a.ty, b.ty) }; }

  /* ---------- CLICK ALSO PLACES (2026-08-07) ----------
     ROOM and HALLWAY were drag-ONLY, and a plain click was worse than nothing: it committed a 1×1
     footprint, which the model correctly rejects ("room min 3×3", "hallway too short"). So the most
     natural thing to try with a tool armed — point at the floor and click — was guaranteed to fail
     and to teach a size rule by refusing you. Now a click stamps the LAST SIZE YOU DREW (seeded at
     a sensible default), the same size the hover ghost has been previewing under the cursor the
     whole time, so what a click does is visible BEFORE you commit to it. Dragging still does
     exactly what it always did, and every drag re-teaches the click its size.
     The cursor tile is the footprint's TOP-LEFT — identical to where a drag starts from — so the
     ghost never jumps when you switch from clicking to dragging. */
  const DEFAULT_ROOM = { w: 7, h: 5 };   // one screen-legible room; over MIN_ROOM (3) with room to spare
  let stampW = DEFAULT_ROOM.w, stampH = DEFAULT_ROOM.h;   // last ROOM size drawn
  let hallLen = 8, hallVert = false;                      // last HALLWAY run drawn (long axis + orientation)
  const roomStampRect = (tx, ty) => ({ x1: tx, y1: ty, x2: tx + stampW - 1, y2: ty + stampH - 1 });
  const hallStampRect = (tx, ty) => hallVert
    ? { x1: tx, y1: ty, x2: tx + hallWidth - 1, y2: ty + hallLen - 1 }
    : { x1: tx, y1: ty, x2: tx + hallLen - 1, y2: ty + hallWidth - 1 };
  const stampRectFor = (tx, ty) => (tool === 'hall' ? hallStampRect(tx, ty) : roomStampRect(tx, ty));
  // remember what a completed drag drew, so the next click repeats it
  function rememberDrawn(rect) {
    const w = rect.x2 - rect.x1 + 1, h = rect.y2 - rect.y1 + 1;
    if (tool === 'hall') { hallVert = h > w; hallLen = Math.max(w, h); }
    else { stampW = w; stampH = h; }
  }
  // a corridor lane along the dominant drag axis; its WIDTH grows toward the drag, not always south/east
  function laneRect(a, b) {
    const dx = b.tx - a.tx, dy = b.ty - a.ty, w = hallWidth - 1;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const y1 = dy < 0 ? a.ty - w : a.ty, y2 = dy < 0 ? a.ty : a.ty + w;
      return { x1: Math.min(a.tx, b.tx), y1, x2: Math.max(a.tx, b.tx), y2 };
    }
    const x1 = dx < 0 ? a.tx - w : a.tx, x2 = dx < 0 ? a.tx : a.tx + w;
    return { x1, y1: Math.min(a.ty, b.ty), x2, y2: Math.max(a.ty, b.ty) };
  }
  // a belt run is a single-tile-wide line along the dominant drag axis; returns {rect, dir}
  function beltRun(a, b) {
    const dx = b.tx - a.tx, dy = b.ty - a.ty;
    const horiz = Math.abs(dx) >= Math.abs(dy);
    const dir = horiz ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
    const rect = horiz ? { x1: Math.min(a.tx, b.tx), y1: a.ty, x2: Math.max(a.tx, b.tx), y2: a.ty }
                       : { x1: a.tx, y1: Math.min(a.ty, b.ty), x2: a.tx, y2: Math.max(a.ty, b.ty) };
    return { rect, dir };
  }
  function beltRunBox(a, b) { return beltRun(a, b).rect; }

  /* ---------- SNAP FLUSH (2026-08-10) ----------
     Andrew's own station, read out of his save: EIGHT rooms, and not one pair of them touching —
     r5/r6/r7/r8 sit ONE tile off r1, r3 two, r9 three. The seam classifier finds 0 open joins, so
     what reads as "the floors won't blend" is not a blend failure at all: it is eight separate
     hulls, each correctly drawing its own wall and shell across a gap of void. Close the gaps and
     the same seven rooms give 72 open joins and one continuous deck.

     Nothing was stopping him. `checkRects` rejects OVERLAP and nothing else, so a one-tile gap is a
     perfectly legal placement — and at TILE=12 it is a handful of screen pixels, invisible until the
     bake draws two walls where you expected none. The tool let you miss by one and said nothing.

     So the fix is in the GESTURE, not the bake: within SNAP_FIT tiles of an existing footprint, a
     placement lands FLUSH against it. Two behaviours, because the two gestures mean different things:
       · a CLICK stamps a remembered size -> TRANSLATE the rect, never resize it. The size is what
         the user last drew and is not ours to change.
       · a DRAG is sizing -> move the EDGE that is near a neighbour, so the room you are drawing
         grows to meet the one already there.
     A snap is only ever offered when the two footprints actually FACE each other (their spans
     overlap on the other axis) — otherwise a room across the station would tug at a placement it can
     never touch. And every candidate is re-validated through the model's own validator before it is
     accepted, so a snap can never create the overlap the snap exists to avoid.

     The ghost and the commit both call this, which is the same contract the LINES tool already
     holds: what a click commits is exactly what was on screen. */
  const SNAP_FIT = 2;   // tiles. 1 is the miss that started this; 2 forgives a slightly wilder aim
  const spanHit = (a1, a2, b1, b2) => Math.max(a1, b1) <= Math.min(a2, b2);
  function snapFit(rect, opts) {
    const resize = !!(opts && opts.resize), ignoreId = opts && opts.ignoreId;
    const list = (station.rooms && station.rooms()) || [];
    if (!list.length) return rect;
    /* MOVE hands its own validator in. It has to: `tool` is 'select' and `kind` is whatever the ROOM
       palette happens to have selected, so validating a dragged corridor against the armed room kind
       would ask the model an unrelated question and take its answer. A multi-rect room also has to
       be validated as the whole set, not as its bounding box. */
    const legal = (opts && opts.validate) || ((r) => {
      const v = (tool === 'hall') ? station.canPlaceHallway([r], ignoreId) : station.canPlaceRoom([r], kind, ignoreId);
      return !!(v && v.ok);
    });
    if (!legal(rect)) return rect;   // already illegal — snapping would only hide why

    // every flush position this rect could take against a footprint it actually faces
    const cand = [];
    for (const rm of list) {
      if (ignoreId && rm.id === ignoreId) continue;
      for (const o of rm.rects) {
        if (spanHit(rect.y1, rect.y2, o.y1, o.y2)) {
          cand.push({ ax: 'x', edge: 'x1', to: o.x2 + 1 });   // our left edge meets their right
          cand.push({ ax: 'x', edge: 'x2', to: o.x1 - 1 });   // our right edge meets their left
        }
        if (spanHit(rect.x1, rect.x2, o.x1, o.x2)) {
          cand.push({ ax: 'y', edge: 'y1', to: o.y2 + 1 });
          cand.push({ ax: 'y', edge: 'y2', to: o.y1 - 1 });
        }
      }
    }
    if (!cand.length) return rect;

    let out = rect;
    for (const ax of ['x', 'y']) {                       // each axis resolves once, independently
      let best = null;
      for (const c of cand) {
        if (c.ax !== ax) continue;
        const d = c.to - out[c.edge];
        if (d === 0 || Math.abs(d) > SNAP_FIT) continue;
        const next = resize
          ? { ...out, [c.edge]: c.to }                                          // drag: the edge moves
          : (ax === 'x' ? { ...out, x1: out.x1 + d, x2: out.x2 + d }            // click: the whole rect slides
                        : { ...out, y1: out.y1 + d, y2: out.y2 + d });
        // a resize may not collapse the footprint under the model's own minimum
        const w = next.x2 - next.x1 + 1, h = next.y2 - next.y1 + 1;
        const min = (tool === 'room') ? station.MIN_ROOM : 1;
        if (w < min || h < min) continue;
        if (!legal(next)) continue;
        if (!best || Math.abs(d) < best.d) best = { d: Math.abs(d), next };
      }
      if (best) out = best.next;
    }
    return out;
  }

  /* MOVE snaps too — relocating a room next to another is the same gesture with the same one-tile
     miss. The whole footprint translates, so the snap is computed on its bounding box and the
     resulting delta is applied to every rect; an L-shaped room keeps its shape. */
  function snapMoveDelta(rm, dx, dy) {
    if (!rm || !rm.rects || !rm.rects.length) return { dx, dy };
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rm.rects) { if (r.x1 < x1) x1 = r.x1; if (r.y1 < y1) y1 = r.y1; if (r.x2 > x2) x2 = r.x2; if (r.y2 > y2) y2 = r.y2; }
    const moved = { x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy };
    const shift = (ddx, ddy) => rm.rects.map(r => ({ x1: r.x1 + dx + ddx, y1: r.y1 + dy + ddy, x2: r.x2 + dx + ddx, y2: r.y2 + dy + ddy }));
    const validate = (r) => {
      const rects = shift(r.x1 - moved.x1, r.y1 - moved.y1);
      const v = rm.kind === 'corridor' ? station.canPlaceHallway(rects, rm.id) : station.canPlaceRoom(rects, rm.kind, rm.id);
      return !!(v && v.ok);
    };
    const s = snapFit(moved, { ignoreId: rm.id, validate });
    return { dx: dx + (s.x1 - moved.x1), dy: dy + (s.y1 - moved.y1) };
  }

  let propHoverMemo = null;
  /* WILL IT CONNECT? (2026-09-23 playtest) — the ghost asks the model which EXISTING machines a placement would
     hook (station.connectionPreview: the compiler's own ring rule), so a line stamped against another, or a
     machine dropped against a lane, turns the ghost AMBER and names what it joins before the click. Placement
     stays allowed (sandbox — never gate); the point is that no connection is ever made without being shown.
     Memoized per (floor edit, candidate) — the frame loop calls ghostInfo every frame. */
  let linkMemo = null;
  function ghostLinks(cand) {
    if (!station || typeof station.connectionPreview !== 'function') return [];
    const key = geoVer + '|' + JSON.stringify(cand);
    if (linkMemo && linkMemo.key === key) return linkMemo.links;
    let links = [];
    try { links = station.connectionPreview(cand) || []; } catch (_) { links = []; }
    linkMemo = { key, links };
    return links;
  }
  const isWorkflowType = t => !!CONNECT_TYPES[t];
  // the words for what a placement would join — agents by name, a named line's INBOX by its line
  function linkNames(links) {
    const names = [];
    for (const l of links || []) {
      const n = l.t === 'bay' ? (l.label ? String(l.label).toUpperCase() : l.agentId ? String(agentLabelFor(l.agentId)).toUpperCase() : 'AN EMPTY BAY')
        : l.t === 'intake' ? lineWordOf(l)
        : l.t === 'outbox' ? 'AN OUTBOX' : 'A ' + propLabel(l.t);
      if (names.indexOf(n) < 0) names.push(n);
    }
    return names.length > 3 ? names.slice(0, 3).join(' + ') + ' +' + (names.length - 3) : names.join(' + ');
  }
  // a MOVE of a workflow machine: which of its belt hookups would it leave behind at the new spot? (a ring-rule floor
  // only — on a linked floor its belts come with it)
  function beltsLeftBehind(p, nx, ny) {
    if (!p || !isWorkflowType(p.t) || typeof station.hookedBelts !== 'function' || linkedFloor()) return 0;
    const w = p.w || 1, h = p.h || 1;
    return station.hookedBelts(p.id).filter(b => !(b.x >= nx - 1 && b.x <= nx + w && b.y >= ny - 1 && b.y <= ny + h)).length;
  }
  // what a MOVE did, said as it happened: on a linked floor its belts came with it — or one found no route and stayed off
  function moveMsg(res, left, okMsg) {
    if (!res || !res.ok) return okMsg;
    // (a belt that cannot follow refuses the move itself — moveProp's LINK_LOST, ITS BELT CAN’T FOLLOW HERE: no move ever lands with a
    //  belt taken up, so there is no "moved — its belts were taken up" to say any more — wave 2, worldmodel-09)
    const relaid = Array.isArray(res.relaid) ? res.relaid.length : 0;
    if (relaid) return okMsg.replace(/ · Undo restores the previous position$/, '') + ' · its belt' + (relaid === 1 ? '' : 's') + ' came with it';
    return left ? 'moved — its belts stayed behind · reconnect with BELT (Undo puts it back)' : okMsg;
  }
  // a move ghost's verdict (SETTLE above): furniture is judged at once (no compile); a conveyor piece shows its footprint
  // verdict on the tiles it crosses and its full route verdict where the pointer rests
  function moveVerdict(p, nx, ny, dx, dy) {
    const full = () => station.canMoveProp ? station.canMoveProp(p.id, nx, ny) : station.canPlaceProp(p.t, nx, ny, p.w, p.h, p.id);
    if (!(dx || dy) || !station.canMoveProp || !isConveyorPiece(p) || settled('m|' + geoVer + '|' + p.id + '|' + nx + ',' + ny)) return full();
    const cheap = station.canPlaceProp(p.t, nx, ny, p.w, p.h, p.id);
    return cheap && cheap.ok ? { ok: true, checking: true } : cheap;
  }
  function groupMoveVerdict(ps, dx, dy) {
    const full = () => station.canMoveProps ? station.canMoveProps(ps.map(p => p.id), dx, dy) : groupFit(ps, dx, dy);
    if (!(dx || dy) || !station.canMoveProps || !ps.some(isConveyorPiece) || settled('g|' + geoVer + '|' + ps.map(p => p.id).join(',') + '|' + dx + ',' + dy)) return full();
    const cheap = groupFit(ps, dx, dy);
    return cheap && cheap.ok ? { ok: true, checking: true } : cheap;
  }
  function ghostInfo() {
    if (!drag) {
      // DUPE armed: the copy ghosts under the cursor with no drag — every click stamps
      if (tool === 'dupe' && dupe && hoverTile) return dupeGhost(hoverTile.tx, hoverTile.ty);
      // LINES armed: the whole blueprint ghosts under the cursor — click stamps, red stays red
      if (tool === 'line' && hoverTile) return lineGhost(hoverTile.tx, hoverTile.ty);
      // Show a prop's occupied footprint before the click. Validation is stable while the
      // pointer, orientation and station stay put; avoid a model walk on every paint frame.
      // (over the SELECTED piece a press drags it — pressMovesSelection — so no stamp ghost promises a placement there)
      if (placingProp() && hoverTile && !(tool !== 'select' && hoverPropId && (hoverPropId === selectedPropId || groupIds.includes(hoverPropId)) && pressMovesSelection())) {
        const { tx, ty } = hoverTile, facing = propFacing(propType);
        const key = [geoVer, propType, facing, tx, ty].join('|');
        if (!propHoverMemo || propHoverMemo.key !== key) {
          const s = propBox(propType, facing);
          // the click's JUNCTION SNAP, asked here too: the ghost stands where the click will put it, judged as the click will judge it
          const sn = junctionSnap(propType, tx, ty), gx = sn ? sn.x : tx, gy = sn ? sn.y : ty;
          const rect = { x1: gx, y1: gy, x2: gx + s.w - 1, y2: gy + s.h - 1 };
          // THE HAND: a junction held over a belt goes ON that belt (junctionOnBelt) — green where it may, red with the reason
          const onBelt = JUNCTION_TAG_TYPES[propType] && station.beltAt(gx, gy) && linkedFloor() && typeof station.junctionOnBeltRefusal === 'function';
          const foot = beltUnderFoot(propType,gx,gy,s);
          if (foot) { propHoverMemo = { key, ghost: { rects:[landRect(foot, rect, s)], v:foot.v, kind:'prop', stamp:true, insert:foot.v.ok, links:[] } }; } else if (onBelt) {
            const no = station.junctionOnBeltRefusal(gx, gy);
            propHoverMemo = { key, ghost: { rects: [rect], v: no ? { ok: false, msg: no.msg, short: no.short } : { ok: true }, kind: 'prop', stamp: true, insert: true, links: [] } };
          } else if (sn) {
            propHoverMemo = { key, ghost: { rects: [rect], v: station.canPlaceProp(propType, gx, gy, s.w, s.h), kind: 'prop', stamp: true, links: [] } };
          } else {
            const links = isWorkflowType(propType) ? ghostLinks({ props: [{ t: propType, x: tx, y: ty, w: s.w, h: s.h }] }) : [];
            propHoverMemo = { key, ghost: { rects: [rect], v: station.canPlaceProp(propType, tx, ty, s.w, s.h), kind: 'prop', stamp: true, links } };
          }
        }
        return propHoverMemo.ghost;
      }
      // ROOM / HALLWAY armed: the footprint a CLICK would stamp, previewed under the cursor and
      // validated live — so "what happens if I press here" is answered before you press. A drag
      // from the same tile takes over the moment you move (drag.mode 'draw' below).
      if ((tool === 'room' || tool === 'hall') && hoverTile && !station.propAt(hoverTile.tx, hoverTile.ty)) {
        const rect = snapFit(stampRectFor(hoverTile.tx, hoverTile.ty), {});
        const v = tool === 'hall' ? station.canPlaceHallway([rect]) : station.canPlaceRoom([rect], kind);
        return { rects: [rect], v, kind: tool, stamp: true };
      }
      return null;
    }
    if (drag.mode === 'draw') {
      const rect = snapFit((tool === 'hall') ? laneRect(drag.start, drag.cur) : norm(drag.start, drag.cur), { resize: true });
      const v = (tool === 'hall') ? station.canPlaceHallway([rect]) : station.canPlaceRoom([rect], kind);
      return { rects: [rect], v, kind: tool };
    }
    if (drag.mode === 'beltrun') {
      const br = beltRun(drag.start, drag.cur);
      return { rects: [br.rect], v: station.canPlaceBeltRun(drag.start, drag.cur), belt: true, dir: br.dir };
    }
    if (drag.mode === 'propstamp') {
      const row = rowSpots(drag);
      if (row) return { rects: row.map(r => ({ x1: r.x, y1: r.y, x2: r.x + r.w - 1, y2: r.y + r.h - 1 })), v: { ok: row.some(r => r.v && r.v.ok) }, kind: 'prop', row };
      const s = propBox(propType, propFacing(propType)), tx = drag.cur.tx, ty = drag.cur.ty;   // ghost shows the TURNED box
      const rect = { x1: tx, y1: ty, x2: tx + s.w - 1, y2: ty + s.h - 1 };
      const links = isWorkflowType(propType) ? ghostLinks({ props: [{ t: propType, x: tx, y: ty, w: s.w, h: s.h }] }) : [];
      const foot = beltUnderFoot(propType,tx,ty,s);
      return { rects: [landRect(foot, rect, s)], v: foot ? foot.v : station.canPlaceProp(propType, tx, ty, s.w, s.h), kind: 'prop', links: foot ? [] : links, insert: !!(foot && foot.v.ok) };
    }
    if (drag.mode === 'propmove') {
      const p = station.propById(drag.propId); if (!p) return null;
      const dx = drag.cur.tx - drag.start.tx, dy = drag.cur.ty - drag.start.ty;
      const nx = p.x + dx, ny = p.y + dy;
      const rect = { x1: nx, y1: ny, x2: nx + p.w - 1, y2: ny + p.h - 1 };
      const links = isWorkflowType(p.t) && (dx || dy) ? ghostLinks({ props: [{ t: p.t, x: nx, y: ny, w: p.w, h: p.h }], ignoreId: p.id }) : [];
      return { rects: [rect], v: moveVerdict(p, nx, ny, dx, dy), move: true, dx, dy, preview:{...p,x:nx,y:ny}, links, leftBehind: (dx || dy) ? beltsLeftBehind(p, nx, ny) : 0 };
    }
    if (drag.mode === 'roomresize') {
      const rm = station.roomById(drag.roomId), nr = rm && resizedRect(drag); if (!nr) return null;
      return { rects: [nr], v: resizeCheck(rm, nr), kind: 'resize' };
    }
    if (drag.mode === 'groupmove') {
      const ps = groupIds.map(id => station.propById(id)).filter(Boolean); if (!ps.length) return null;
      const dx = drag.cur.tx - drag.start.tx, dy = drag.cur.ty - drag.start.ty;
      return { rects: ps.map(p => propRect(p, dx, dy)), v: groupMoveVerdict(ps, dx, dy), move: true, dx, dy, group: ps.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
    }
    if (drag.mode === 'move') {
      const rm = station.roomById(drag.roomId); if (!rm) return null;
      const raw = { dx: drag.cur.tx - drag.start.tx, dy: drag.cur.ty - drag.start.ty };
      const { dx, dy } = snapMoveDelta(rm, raw.dx, raw.dy);
      const rects = rm.rects.map(r => ({ x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy }));
      const v = rm.kind === 'corridor' ? station.canPlaceHallway(rects, rm.id) : station.canPlaceRoom(rects, rm.kind, rm.id);
      return { rects, v, move: true, dx, dy };
    }
    return null;
  }

  /* ---------- render loop ---------- */
  function rebake() {
    // Prop-only edits still replace geometry: collision, mounts and capability
    // routing must see the new objects even when the environment pixels survive.
    if (bakeDirty || !cache || projectionDirty) cacheGeo = station.projectGeometry();
    if (bakeDirty || !cache) {
      const visibleRect = visibleBakeRect(cacheGeo);
      cache = StationBake.bakeIncremental
        ? StationBake.bakeIncremental(cacheGeo, cache, bakeDirtyRects, { visibleRect, maxRetainedChunks: MAX_REFIT_CHUNKS, onlyMissingVisible: bakeVisibleOnly })
        : StationBake.bake(cacheGeo);
    }
    /* recompile the routing plan ONLY when the floor actually changed (planDirty — set by station.onChange
       and open(), the two edit paths; world.js compileRouting is gated the same way via its geoDirty edit
       flag). rebake() ALSO runs on pure pans (frame() flips bakeDirty+bakeVisibleOnly when visible chunks
       are missing), and recompiling plan + liveTiles + the key-rebase on every pan was pure waste: the
       geometry is identical, so the plan (and valLive — origin only moves on edits) is still exact. */
    if (planDirty || !valPlan) {
      valPlan = (typeof Pipeline !== 'undefined') ? Pipeline.compileRoutingPlan(cacheGeo) : null;   // cost-safety: recompute the routing plan on every floor edit
      // dead-vs-live belt render mirrors the live world. The plan is compiled in cacheGeo's LOCAL frame but
      // drawConveyor draws station.belts() in WORLD tiles — rebase the live keys by the geo origin or every
      // BUILD MODE belt would look cold (frame-mismatch, not truth).
      valLive = null;
      if (valPlan && Pipeline.liveTiles) {
        const lv = Pipeline.liveTiles(valPlan), o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
        valLive = {};
        for (const k in lv) { const p = k.split(','); valLive[(+p[0] + o.tx) + ',' + (+p[1] + o.ty)] = true; }
      }
      planDirty = false;
      // finish-the-line: regroup the floor's physical lines from the SAME geometry the plan compiled
      valComps = (typeof Pipeline !== 'undefined' && Pipeline.lineComponents) ? Pipeline.lineComponents(cacheGeo) : [];
      // a floor edit just recompiled the plan — the line may have just powered on. Judged on THESE lines (2026-10-14: it ran
      // before the regroup, so entry saw no lines at all and the first edit found every complete line "new" — LINE READY on
      // an untouched line after one lone INBOX)
      maybeFirstRide();
      if (lastStampIds) {   // a stamp just landed — the card adopts the stamped line
        const set = {}; for (const id of lastStampIds) set[id] = 1;
        const c = valComps.find(cc => cc.props.some(id => set[id]));
        if (c) finKeySel = c.key;
        lastStampIds = null;
      }
      renderFinCard();
      refreshLineFacts();   // an open STEP/flow card's "ON <LINE> — feeds …" line follows the recompiled plan
      // ghost projection (Phase 3): same plan, same components, same frame rebase as everything above
      if (ghost) ghost.setContext({ plan: valPlan, comps: valComps, offset: (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 } });
    }
    projectionDirty = false;
    bakeDirty = false; bakeDirtyRects = null; bakeDirtyRectsGlobal = false; bakeVisibleOnly = false;
  }

  // A browser animation callback has no supervisor: if one draw dependency throws, the callback exits before
  // the next requestAnimationFrame at the foot of this function and BUILD MODE remains a black overlay forever.
  // Closing and reopening appeared to "fix" it only because open() started a brand-new loop after the transient
  // startup condition (asset decode/layout/cache warm-up) had passed. Keep the loop host-owned: one bad frame is
  // logged, its derived bake is discarded, and a bounded retry re-measures + re-fits from canonical station state.
  function scheduleFrame(failed) {
    if (!running) return;
    if (!failed) { raf = requestAnimationFrame(frame); return; }
    const delay = Math.min(1000, 80 * Math.pow(2, Math.min(4, Math.max(0, frameFailures - 1))));
    clearTimeout(frameRetryTimer);
    frameRetryTimer = setTimeout(() => {
      frameRetryTimer = 0;
      if (running) raf = requestAnimationFrame(frame);
    }, delay);
  }

  function recoverFrame(err) {
    frameFailures++;
    if (root) {
      root.dataset.renderState = 'recovering';
      root.dataset.renderFailures = String(frameFailures);
    }
    // Capture the short startup sequence with stacks; persistent failures stay bounded by the backoff and then
    // report only every tenth attempt instead of flooding the desktop console at 60fps.
    if (frameFailures <= 5 || frameFailures % 10 === 0) console.error('[refit] render failed; retrying', err);
    cache = null; cacheGeo = null;
    bakeDirty = true; bakeDirtyRects = null; bakeDirtyRectsGlobal = false; bakeVisibleOnly = false; planDirty = true;
    // A first desktop layout pass can change the backing size between open() and the first paint. Re-measure and
    // frame the canonical bounds during recovery so a stale 0/small viewport cannot leave the station offscreen.
    try { resize(); fitCamera(); } catch (_) {}
  }

  /* ---------- ONE BAD LAYER MUST NOT BLANK THE CANVAS ----------
     The frame used to be a single try/catch: any draw dependency that threw skipped EVERY layer
     after it and then had its bake discarded and retried forever, so BUILD MODE read as a black overlay.
     A real case: a refused sidecar (the page's token dies when the sidecar restarts under it) left
     prop data undefined and PropSprites threw out of drawProps — the light layer, the ghost and
     every label after it never ran, on a loop.

     Each layer now paints inside its own guard. A failure costs THAT layer and nothing else; the
     rest of the frame paints. It is reported (one console.warn per layer per session — not
     silenced, and never papered over with fake state) and stamped on the overlay's dataset so a
     harness can read the degradation instead of guessing at a dark screenshot.

     STATE HYGIENE: a layer that throws mid-draw leaves the 2D context wherever it died — an
     unbalanced save(), a stray globalAlpha, a clip. The guard brackets the layer with its own
     save() and unwinds to exactly that depth afterwards, detected with a sentinel miterLimit
     (the 2D API exposes no stack depth). Without the unwind, one throwing layer per frame would
     leak the context state stack forever. */
  const LAYER_MITER = 10, LAYER_SENTINEL = 7.3125;   // an ordinary value nothing in this file sets
  const layerFailed = Object.create(null);
  /* ---------- FRAME COST INSTRUMENT (2026-08-08) ----------
     OFF by default and off in every shipped frame: `perfAcc` is null, so the whole instrument costs
     one null test per layer. A harness turns it on (__test__.perf(true)), lets the loop run, and
     reads back real per-layer totals — a perf claim on this file is otherwise just a story. */
  let perfAcc = null;
  function perfAdd(name, ms) { const a = perfAcc[name] || (perfAcc[name] = { n: 0, ms: 0 }); a.n++; a.ms += ms; }
  function drawLayer(name, fn) {
    const pt0 = perfAcc ? performance.now() : 0;
    ctx.miterLimit = LAYER_MITER;
    ctx.save();
    ctx.miterLimit = LAYER_SENTINEL;   // everything the layer pushes inherits this mark
    try {
      fn();
    } catch (err) {
      if (!layerFailed[name]) {
        layerFailed[name] = 1;
        console.warn('[refit] draw layer "' + name + '" failed — the rest of the frame still paints', err);
      }
      if (root) root.dataset.renderDegraded = Object.keys(layerFailed).join(',');
    }
    // pop back to (and including) our own save, whatever depth the layer left behind
    for (let i = 0; i < 64 && ctx.miterLimit === LAYER_SENTINEL; i++) ctx.restore();
    if (perfAcc) perfAdd(name, performance.now() - pt0);
  }

  function frame(now) {
    if (!running) return;
    let failed = false;
    const fT0 = perfAcc ? performance.now() : 0;
    insMemo = null;   // one layout measurement per frame at most (viewInsetsFrame)
    try {
    const visibleRect = cacheGeo ? visibleBakeRect(cacheGeo) : null;
    if (visibleRect && cache && StationBake.missingVisibleChunks && StationBake.missingVisibleChunks(cache, visibleRect).length) {
      bakeDirty = true; bakeVisibleOnly = true;
    }
    if (bakeDirty || !cache || planDirty) rebake();
    // an armed first ride waits out the tutorial + the first-run card (.refit-firstrun, never .refit-guide)
    // ONE VOICE: the first ride waits while the presets dialog or a preset's setup guide is open (staffing in the guide is
    // what completes the line) — it narrates on the floor once that card closes, never over it
    if (ridePending && !tutorialCoaching() && !(root && root.querySelector('.refit-firstrun, .refit-preset-example, .refit-station-builds'))) fireFirstRide();
    // finish-the-line card: slow re-derive (feed truth changes on the world's poll, not on edits) + per-frame pin
    if (finCardEl && now - finPollTs > 2000) { finPollTs = now; renderFinCard(); }
    // the authored prop art landed after the Workflow panel painted its tiles: repaint it once the loading settles, so a tile never
    // keeps the fallback sprite (the machine stills are re-made per remaster revision)
    const artRev = (typeof PropRemaster !== 'undefined' && PropRemaster.revision) ? PropRemaster.revision() : 0;
    if (artRev !== wfArtRev) { wfArtRev = artRev; wfArtAt = now; }
    else if (wfArtAt && now - wfArtAt > 250) { wfArtAt = 0; if (typeof WorkflowPanel !== 'undefined' && WorkflowPanel.isOpen()) WorkflowPanel.refresh(); }
    const hT0 = perfAcc ? performance.now() : 0;
    positionFinCard();
    if (perfAcc) perfAdd('~finCard', performance.now() - hT0);
    const rT0 = perfAcc ? performance.now() : 0;
    updateTopReadout();   // station stats + the live zoom % (both self-throttle on an unchanged value)
    if (perfAcc) perfAdd('~topReadout', performance.now() - rT0);
    const t = T();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // The backdrop, shared with the live world (SpaceBG) so entering/exiting BUILD MODE doesn't jump the sky —
    // same selection, same camera contract (BUILD MODE's zoom is the world's `scale`), so the parallax matches too.
    // A LANDED station has no sky: the ground layer below covers the frame, so skip the starfield entirely.
    if (typeof Terrain !== 'undefined' && Terrain.active()) {
      ctx.fillStyle = Terrain.baseColor(); ctx.fillRect(0, 0, cv.width, cv.height);
    } else if (typeof SpaceBG !== 'undefined') SpaceBG.draw(ctx, cv.width, cv.height, now, { panX, panY, scale: zoom });
    else { ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height); }

    ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
    ctx.imageSmoothingEnabled = false;
    const ox = cache.origin.tx * t, oy = cache.origin.ty * t;
    if (sceneRenderer) sceneRenderer.begin({ geo: cacheGeo, cache, now, scale: zoom,
      panX: panX + ox * zoom, panY: panY + oy * zoom, width: cv.width, height: cv.height,
      reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches });
    /* the ground, in world space under the bake — BUILD MODE blits the station at (ox,oy), so the
       clearing must be placed there too, not at the origin like the live world.

       THE CLEARING'S SIZE COMES FROM THE GEOMETRY, NOT FROM THE BAKE CANVAS. `cache.baseCv` only
       exists on the WHOLE-CANVAS bake; when StationBake.bakeIncremental is available the cache is
       CHUNKED and has no baseCv at all, so reading `.width` off it threw a TypeError out of the
       draw function before a single pixel of ground or station was painted — BUILD MODE went black.
       The line below it already knew this (it picks drawBase over drawImage(cache.baseCv) for
       exactly that reason); this call did not. cacheGeo carries COLS/ROWS in tiles on both paths. */
    if (typeof Terrain !== 'undefined' && Terrain.active()) {
      const bt = (cacheGeo && cacheGeo.TILE) || t;
      const bw = cacheGeo ? cacheGeo.COLS * bt : (cache.baseCv ? cache.baseCv.width : 0);
      const bh = cacheGeo ? cacheGeo.ROWS * bt : (cache.baseCv ? cache.baseCv.height : 0);
      Terrain.draw(ctx, { scale: zoom, panX, panY }, cv.width, cv.height,
        { x: ox, y: oy, w: bw, h: bh });
    }
    const drawVisibleRect = visibleBakeRect(cacheGeo);
    if (StationBake.drawBase) StationBake.drawBase(ctx, cache, ox, oy, drawVisibleRect);
    else ctx.drawImage(cache.baseCv, ox, oy);
    voiceBegin();   // one-voice law: every text layer below REGISTERS; the arbiter paints at the end
    drawLayer('grid', () => drawGrid(t));
    drawLayer('conveyor', () => drawConveyor(now, t));   // belts (floor) → props → boxes ride on top
    drawLayer('props', () => drawProps(now));
    drawLayer('boxes', () => drawConveyorBoxes(now, t));
    let nextLight = false;
    drawLayer('light', () => {
      if (sceneRenderer) {
        ctx.save(); ctx.translate(ox, oy);
        try { nextLight = sceneRenderer.drawLight(ctx, framePropLights, { ambient: StationBake.LIGHT.ambient, emission: .9 }); }
        finally { ctx.restore(); }
      }
      if (!nextLight) {
        if (StationBake.drawLight) StationBake.drawLight(ctx, cache, ox, oy, drawVisibleRect);
        else ctx.drawImage(cache.lightCv, ox, oy);
      }
    });
    if (!nextLight) drawLayer('glows', () => drawGlows(now));
    drawLayer('sendTo', () => drawSendLinks(t, now));   // SEND TO: each OUTBOX's dashed arc to the INBOX it feeds (an editing instrument, above the light)
    drawLayer('flashes', () => drawFlashes(now, t));
    drawLayer('validation', () => drawRoutingValidation(t, now));
    drawLayer('junctionTags', () => drawJunctionTags(t));   // what each 1×1 junction IS and will DO, under its tile (Conveyors tab)
    drawLayer('altView', () => drawAltView(t));   // THE HAND: Alt shows every setting / SEND TO / stage count (and an over-budget INBOX says n/max at rest)
    drawLayer('workflow', () => drawWorkflowMarks(t, now));   // the docked panel's selection + a paused step test's waiting handoff   // plain-words callouts on any broken piece, IN build mode (cost-safety + guidance)
    drawLayer('beltEndpoints', () => drawBeltEndpointGlow(t, now)); // BELT tool armed → INTAKE glows FROM, BAY/OUTBOX glow TO (what connects to what)
    drawLayer('bayNames', () => {
      if (typeof PropSprites !== 'undefined' && PropSprites.drawBayNames) {
        PropSprites.setCtx(ctx);
        PropSprites.drawBayNames(frameBayLabels, zoom, window.devicePixelRatio || 1);
      }
    });
    // the candidate field is an INSTRUMENT — above the light with the crosshair, or the deck swallows it
    drawLayer('lineField', () => drawLineField(t));
    drawLayer('crosshair', () => drawCrosshair(t));   // the aim instrument — ABOVE the light layer, or the deck swallows it
    drawLayer('hover', () => drawHover(t));
    drawLayer('agentTag', () => drawAgentTag(t));   // hovering a PC or BAY names the agent it's bound to (or flags an unassigned PC)
    drawLayer('ghost', () => drawGhost(t, now));
    drawLayer('hand', () => drawHandGhost(t, now));   // THE HAND: a drag's belt-to-be + the reason at the pointer, or the picker's pin
    // every voice has registered — the arbiter now paints AT MOST one label per anchor region.
    // overFloor: the pointer is on the station (or a gesture is live) → the projection stays quiet.
    // guarded too: the registered labels PAINT here, so a throwing caption would otherwise take the frame
    if (floaters.length) drawLayer('floats', () => drawFloaters(now, t));   // REMOVED / UNDID · <WHAT>: rises over the tiles it names, then fades (a voice, registered before the flush)
    drawLayer('voices', () => voiceFlush(!!drag || !!(hoverRoomId || hoverPropId || (hoverTile && station.beltAt(hoverTile.tx, hoverTile.ty)))));
    // animate the prop-palette preview gallery (~25fps is plenty + cheap). Runs LAST: it hijacks PropSprites'
    // ctx for the offscreen tiles, and the next frame re-points it at the main canvas in drawProps().
    if (tool === 'prop' && propThumbs.length && now - lastThumbTs >= 40) { paintThumbs(now); lastThumbTs = now; }

    frameFailures = 0;
    if (sceneRenderer) sceneRenderer.finish();
    if (root) {
      root.dataset.renderState = 'ready';
      root.dataset.renderFailures = '0';
    }
    } catch (err) {
      failed = true;
      recoverFrame(err);
    } finally {
      if (perfAcc) perfAdd('=FRAME', performance.now() - fT0);
      scheduleFrame(failed);
    }
  }

  /* ---------- THE BLUEPRINT GRID (2026-08-07 build-mode overhaul) ----------
     The old grid was ONE uniform screen-door at alpha .07 across the whole viewport: the void and
     the deck read identically, nothing said where you could build, and no rhythm let you COUNT
     tiles. It is now three concentric readings of the same lattice:

       DECK   — the real footprint. Per-tile cells, brightest: this is floor that exists.
       APRON  — GRID_APRON tiles of open space around the station bounds. Full minor grid: the
                ground you actually build on next, so a drag has something to snap against.
       VOID   — beyond that, MAJOR divisions only, faint. Open space, with a coarse ruler.

     Majors land every GRID_MAJOR tiles (a "bay") so 8 tiles is countable at a glance, and minor
     lines fade out entirely once a tile is only a few device px (below that they alias into a grey
     wash that reads as fog, not grid). The whole lattice steps UP while a placement tool is armed
     and back DOWN in SELECT — in SELECT you're reading the floor, not aligning to it. */
  const GRID_MAJOR = 8;    // tiles per major division — one "bay" of station
  const GRID_APRON = 16;   // tiles of full-resolution grid around the station bounds
  // tools where alignment matters (the grid + crosshair come up for these; SELECT stays quiet)
  const PLACING = { room: 1, hall: 1, paint: 1, move: 1, reclaim: 1, prop: 1, belt: 1, dupe: 1, line: 1 };

  function drawGrid(t) {
    const x0 = (-panX) / zoom, y0 = (-panY) / zoom, x1 = (cv.width - panX) / zoom, y1 = (cv.height - panY) / zoom;
    const tx0 = Math.floor(x0 / t) - 1, ty0 = Math.floor(y0 / t) - 1, tx1 = Math.ceil(x1 / t) + 1, ty1 = Math.ceil(y1 / t) + 1;
    const armed = !!PLACING[tool];
    const lw = 1 / zoom;
    // minor lines below ~5 device px per tile are noise, not grid — fade them out rather than alias
    const px = t * zoom;
    const minorK = clamp((px - 5) / 7, 0, 1);
    const b = boundsMemoed();   // the apron follows the FLOOR, not the camera — once per edit, not per frame
    const ax0 = b.minTx - GRID_APRON, ay0 = b.minTy - GRID_APRON;
    const ax1 = b.maxTx + 1 + GRID_APRON, ay1 = b.maxTy + 1 + GRID_APRON;

    // ---- MINOR: the apron only. Clipped to the buildable neighbourhood, so the void stays open. ----
    const mx0 = Math.max(tx0, ax0), my0 = Math.max(ty0, ay0), mx1 = Math.min(tx1, ax1), my1 = Math.min(ty1, ay1);
    const hasApron = mx1 > mx0 && my1 > my0;
    if (minorK > 0.02 && hasApron) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(120,200,255,' + (minorK * (armed ? 0.15 : 0.04)).toFixed(3) + ')';
      ctx.beginPath();
      for (let gx = mx0; gx <= mx1; gx++) { ctx.moveTo(gx * t, my0 * t); ctx.lineTo(gx * t, my1 * t); }
      for (let gy = my0; gy <= my1; gy++) { ctx.moveTo(mx0 * t, gy * t); ctx.lineTo(mx1 * t, gy * t); }
      ctx.stroke();
    }

    // ---- MAJOR: every GRID_MAJOR tiles. Faint across the whole view (a horizon ruler), then a
    //      second brighter pass clipped to the apron so the falloff reads as depth, not a hard edge.
    const majX = [], majY = [];
    for (let gx = Math.ceil(tx0 / GRID_MAJOR) * GRID_MAJOR; gx <= tx1; gx += GRID_MAJOR) majX.push(gx);
    for (let gy = Math.ceil(ty0 / GRID_MAJOR) * GRID_MAJOR; gy <= ty1; gy += GRID_MAJOR) majY.push(gy);
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(130,205,255,' + (armed ? 0.10 : 0.04) + ')';
    ctx.beginPath();
    for (const gx of majX) { ctx.moveTo(gx * t, y0); ctx.lineTo(gx * t, y1); }
    for (const gy of majY) { ctx.moveTo(x0, gy * t); ctx.lineTo(x1, gy * t); }
    ctx.stroke();
    if (hasApron) {
      ctx.strokeStyle = 'rgba(160,220,255,' + (armed ? 0.17 : 0.065) + ')';
      ctx.beginPath();
      for (const gx of majX) { if (gx < mx0 || gx > mx1) continue; ctx.moveTo(gx * t, my0 * t); ctx.lineTo(gx * t, my1 * t); }
      for (const gy of majY) { if (gy < my0 || gy > my1) continue; ctx.moveTo(mx0 * t, gy * t); ctx.lineTo(mx1 * t, gy * t); }
      ctx.stroke();
    }

    // ---- DECK: per-tile cells over the real footprint — the brightest reading, floor that exists ----
    if (cacheGeo && (tx1 - tx0) * (ty1 - ty0) < 6000) {
      const ox = cacheGeo.origin.tx, oy = cacheGeo.origin.ty, zg = cacheGeo.zoneGrid, idx = cacheGeo.idx, C = cacheGeo.COLS, R = cacheGeo.ROWS;
      ctx.strokeStyle = 'rgba(140,210,255,' + (minorK * (armed ? 0.20 : 0.055) + 0.03).toFixed(3) + ')';
      ctx.beginPath();
      for (let gy = ty0; gy <= ty1; gy++) for (let gx = tx0; gx <= tx1; gx++) {
        const lx = gx - ox, ly = gy - oy;
        if (lx < 0 || ly < 0 || lx >= C || ly >= R || zg[idx(lx, ly)] == null) continue;
        ctx.rect(gx * t + 0.5 / zoom, gy * t + 0.5 / zoom, t - 1 / zoom, t - 1 / zoom);
      }
      ctx.stroke();
    }
  }

  /* The alignment crosshair: with a build tool armed, the tile under the pointer lights up and its
     row + column rule out across the view. This is the single thing that turns "drag somewhere and
     hope" into "line this up with that" — you can see, before you press, exactly which column your
     next room will start on and what it lines up with across the floor. Muted during a drag: the
     ghost's own rulers take over there (drawGhost), and two sets of guides is a clusterfuck.

     Drawn in the OVERLAY pass, not inside drawGrid. The grid is painted before StationBake.drawLight,
     which is right for a lattice that should read as part of the floor and wrong for an instrument:
     the light canvas multiplied a .22 rule down to nothing over the very deck you aim at, so the
     crosshair was invisible in exactly the place it exists to serve. */
  function drawCrosshair(t) {
    if (!PLACING[tool] || drag || !hoverTile) return;
    const x0 = (-panX) / zoom, y0 = (-panY) / zoom, x1 = (cv.width - panX) / zoom, y1 = (cv.height - panY) / zoom;
    const hx = hoverTile.tx, hy = hoverTile.ty;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = 'rgba(150,225,255,0.34)';
    ctx.beginPath();
    ctx.moveTo(hx * t + 0.5 / zoom, y0); ctx.lineTo(hx * t + 0.5 / zoom, y1);
    ctx.moveTo((hx + 1) * t - 0.5 / zoom, y0); ctx.lineTo((hx + 1) * t - 0.5 / zoom, y1);
    ctx.moveTo(x0, hy * t + 0.5 / zoom); ctx.lineTo(x1, hy * t + 0.5 / zoom);
    ctx.moveTo(x0, (hy + 1) * t - 0.5 / zoom); ctx.lineTo(x1, (hy + 1) * t - 0.5 / zoom);
    ctx.stroke();
    ctx.fillStyle = 'rgba(150,225,255,0.16)';
    ctx.fillRect(hx * t, hy * t, t, t);
    // corner ticks on the aimed tile — the "you are here" the flat fill alone doesn't carry
    const k = Math.min(t * 0.34, 5 / zoom);
    ctx.strokeStyle = 'rgba(190,240,255,0.85)'; ctx.lineWidth = 1.4 / zoom;
    const X = hx * t, Y = hy * t;
    ctx.beginPath();
    ctx.moveTo(X, Y + k); ctx.lineTo(X, Y); ctx.lineTo(X + k, Y);
    ctx.moveTo(X + t - k, Y); ctx.lineTo(X + t, Y); ctx.lineTo(X + t, Y + k);
    ctx.moveTo(X + t, Y + t - k); ctx.lineTo(X + t, Y + t); ctx.lineTo(X + t - k, Y + t);
    ctx.moveTo(X + k, Y + t); ctx.lineTo(X, Y + t); ctx.lineTo(X, Y + t - k);
    ctx.stroke();
  }

  const _fixtureGlow = new WeakMap();
  function drawGlows(now) {
    if (!cache.flickers) return;
    const t = T(), ox = cache.origin.tx * t, oy = cache.origin.ty * t;
    if (cache.interiorPath) {
      ctx.save(); ctx.translate(ox, oy); ctx.clip(cache.interiorPath); ctx.translate(-ox, -oy);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const f of cache.flickers) {
      let entry = _fixtureGlow.get(f);
      if (!entry || entry.ox !== ox || entry.oy !== oy) {
        const g = ctx.createRadialGradient(ox + f.x, oy + f.y, 1, ox + f.x, oy + f.y, f.r * 0.7);
        const rgb = f.rgb || '238,218,184';
        g.addColorStop(0, 'rgba(' + rgb + ',1)'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
        entry = { g, ox, oy }; _fixtureGlow.set(f, entry);
      }
      const g = entry.g;
      ctx.globalAlpha = 0.13 * 0.55;
      ctx.fillStyle = g; ctx.fillRect(ox + f.x - f.r * 0.7, oy + f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (cache.interiorPath) ctx.restore();
  }

  /* ---------- PLACEMENT JUICE (2026-08-07 round 3) ----------
     A placement used to answer with a flat colour wash that faded in half a second — the same mark
     for building a room and for tearing one down, and nothing that felt like the station DID
     something. It now reads as fabrication: a phosphor SCAN sweeps the footprint (left→right as
     structure materializes, right→left as it is stripped), a RING pushes out past the edge and
     fades, and the body glow decays under both. Eerie, not cute — it is the same construction
     vocabulary the bake and the CRT already speak, no particles and no confetti. */
  const FLASH_MS = 620, MOVE_MS = 760;
  /* THINGS LAND, THINGS DISSOLVE (2026-10-01 build-mode upgrade — Andrew: "it needs to be easier and more fun to use"). A placed prop
     used to appear in place, still, under the scan: nothing said it had ARRIVED. Now it is fabricated in the air a tile above its spot
     and drops into its own shadow — the shadow is already on the deck, the body falls into it and settles with one small bounce and a
     low thunk. A whole conveyor line drops machine by machine, left to right. A deleted prop is not simply gone: a cut line sweeps
     down through it and it fades out behind the cut, with a falling hiss. Same eerie construction vocabulary as the scan and the ring
     (fabrication, not celebration) — no particles, no confetti. Purely drawn: the model has already changed when either plays. */
  const landings = new Map();   // propId -> start time (a stagger can start it in the future)
  const LAND_MS = 340, LAND_RISE = 14;   // world px above the spot (a little over a tile)
  function landProps(ids, stagger) {
    const t0 = performance.now();
    (ids || []).filter(Boolean).forEach((id, i) => landings.set(id, t0 + (stagger ? i * stagger : 0)));
    if (ids && ids.length) sfxLand();
  }
  // the drop: falls under gravity for 62% of the time, then one small bounce (y < 0 is up, in world px)
  function landState(id, now) {
    const t0 = landings.get(id); if (t0 == null) return null;
    const k = (now - t0) / LAND_MS;
    if (k < 0) return { dy: -LAND_RISE, a: 0 };
    if (k >= 1) { landings.delete(id); return null; }
    const dy = k < 0.62 ? -LAND_RISE * (1 - (k / 0.62) * (k / 0.62)) : -LAND_RISE * 0.16 * Math.sin(Math.PI * (k - 0.62) / 0.38);
    return { dy, a: Math.min(1, 0.35 + k * 2.2) };
  }
  const vanishing = [];   // { p (a copy), mount, t0 }
  const VANISH_MS = 380;
  function vanishProp(p) {
    if (!p) return;
    vanishing.push({ p: Object.assign({}, p), mount: (mountMap && mountMap.get(p.id)) || null, t0: performance.now() });
    sfxVanish();
  }
  function drawVanishing(now) {
    if (!vanishing.length || typeof PropSprites === 'undefined') return;
    const t = T();
    for (let i = vanishing.length - 1; i >= 0; i--) {
      const v = vanishing[i], k = (now - v.t0) / VANISH_MS;
      if (k >= 1) { vanishing.splice(i, 1); continue; }
      const p = v.p, top = p.y * t - 2.2 * t, bot = (p.y + (p.h || 1)) * t, cut = top + (bot - top) * k;
      ctx.save();
      ctx.beginPath(); ctx.rect(p.x * t - t, cut, ((p.w || 1) + 2) * t, bot - cut + t); ctx.clip();
      ctx.globalAlpha = Math.max(0, 1 - k * 1.15);
      try { PropSprites.draw(v.mount ? Object.assign({}, p, { mount: v.mount }) : p, true); } catch (_) {}
      ctx.restore();
      // the cut line itself: a phosphor scan sweeping down through the body
      ctx.save(); ctx.globalAlpha = 0.85 * (1 - k); ctx.fillStyle = 'rgba(255,140,110,1)';
      ctx.fillRect(p.x * t - 1, cut, (p.w || 1) * t + 2, Math.max(1 / zoom, 1.2 / zoom)); ctx.restore();
    }
  }
  // the feel's two sounds, made from the station's own synth (util.js SFX.voice / SFX.noise): a soft low THUNK as something lands,
  // a falling hiss as it dematerializes — quiet, short, gated; the plain click stands in where the synth is not loaded
  let lastLandSfx = 0;
  function sfxLand() {
    const n = performance.now(); if (n - lastLandSfx < 80) return; lastLandSfx = n;
    if (typeof SFX === 'undefined' || !SFX.voice || !SFX.ctx) return;
    try { if (SFX.noise) SFX.noise({ dur: 0.06, cut: 700, cut2: 160, type: 'lowpass', vol: 0.1 }); SFX.voice({ freq: 140, glide: 62, dur: 0.12, type: 'sine', vol: 0.2, atk: 0.002, cut: 800 }); } catch (_) {}
  }
  let lastVanishSfx = 0;
  function sfxVanish() {
    const n = performance.now(); if (n - lastVanishSfx < 80) return; lastVanishSfx = n;   // a group dissolves on one hiss
    if (typeof SFX === 'undefined' || !SFX.noise || !SFX.ctx) return;
    try { SFX.noise({ dur: 0.26, cut: 4200, cut2: 500, type: 'bandpass', q: 1.1, vol: 0.06 }); if (SFX.voice) SFX.voice({ freq: 480, glide: 150, dur: 0.2, type: 'triangle', vol: 0.05, atk: 0.006 }); } catch (_) {}
  }
  function drawFlashes(now, t) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const fl = flashes[i], k = (now - fl.t0) / (fl.moves ? MOVE_MS : FLASH_MS);
      if (k >= 1) { flashes.splice(i, 1); continue; }
      if (fl.moves) { drawMoves(fl, k, t); continue; }
      const ease = 1 - (1 - k) * (1 - k);         // fast out — the sweep leads, the glow trails
      const body = (1 - k) * (fl.bad ? 0.34 : 0.30);
      const hue = fl.bad ? '255,110,90' : '170,255,210';
      for (const r of fl.rects) {
        const X = r.x1 * t, Y = r.y1 * t, W = (r.x2 - r.x1 + 1) * t, H = (r.y2 - r.y1 + 1) * t;
        ctx.fillStyle = 'rgba(' + hue + ',' + body.toFixed(3) + ')';
        ctx.fillRect(X, Y, W, H);
        // THE SCAN — a bright band crossing the footprint once
        const band = Math.max(t * 0.9, W * 0.14);
        const head = fl.bad ? (X + W - ease * (W + band)) : (X - band + ease * (W + band));
        const bx0 = Math.max(X, head), bx1 = Math.min(X + W, head + band);
        if (bx1 > bx0) {
          const g = ctx.createLinearGradient(head, 0, head + band, 0);
          const peak = (0.55 * (1 - k * 0.5)).toFixed(3);
          g.addColorStop(0, 'rgba(' + hue + ',0)');
          g.addColorStop(0.5, 'rgba(' + hue + ',' + peak + ')');
          g.addColorStop(1, 'rgba(' + hue + ',0)');
          ctx.fillStyle = g; ctx.fillRect(bx0, Y, bx1 - bx0, H);
        }
        // THE RING — the footprint's own outline pushing outward as it settles
        const grow = ease * t * 0.9, ra = (1 - ease) * 0.85;
        if (ra > 0.02) {
          ctx.lineWidth = 2 / zoom;
          ctx.strokeStyle = 'rgba(' + hue + ',' + ra.toFixed(3) + ')';
          ctx.strokeRect(X - grow, Y - grow, W + grow * 2, H + grow * 2);
        }
      }
    }
  }

  /* A MACHINE A LINE EDIT MOVED (TIDY LINE, a swap, a line laid afresh round a change): its outline GLIDES from the footprint it
     left to the one it now stands on — eased in and out, the old footprint fading, a dashed wake from where it was. The same
     phosphor construction marks as the placement flash: the station shows the move, it does not animate the machine. */
  function drawMoves(fl, k, t) {
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, a = 1 - k * 0.6, hue = '170,255,210';
    ctx.lineWidth = 2 / zoom;
    for (const m of fl.moves) {
      const fw = (m.from.x2 - m.from.x1 + 1) * t, fh = (m.from.y2 - m.from.y1 + 1) * t;
      const W = (m.to.x2 - m.to.x1 + 1) * t, H = (m.to.y2 - m.to.y1 + 1) * t;
      const X = (m.from.x1 + (m.to.x1 - m.from.x1) * e) * t, Y = (m.from.y1 + (m.to.y1 - m.from.y1) * e) * t;
      ctx.strokeStyle = 'rgba(' + hue + ',' + (0.3 * (1 - k)).toFixed(3) + ')';   // the footprint it left
      ctx.strokeRect(m.from.x1 * t, m.from.y1 * t, fw, fh);
      ctx.setLineDash([3 / zoom, 3 / zoom]);                                       // the wake
      ctx.strokeStyle = 'rgba(' + hue + ',' + (0.4 * a).toFixed(3) + ')';
      ctx.beginPath(); ctx.moveTo(m.from.x1 * t + fw / 2, m.from.y1 * t + fh / 2); ctx.lineTo(X + W / 2, Y + H / 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(' + hue + ',' + (0.16 * a).toFixed(3) + ')';           // the outline, gliding over
      ctx.fillRect(X, Y, W, H);
      ctx.strokeStyle = 'rgba(' + hue + ',' + (0.85 * a).toFixed(3) + ')';
      ctx.strokeRect(X, Y, W, H);
    }
  }

  /* THE SNAP TICK. Sizing a footprint is the core gesture of build mode and it was silent: the
     ghost changed by a tile and nothing marked it, so a drag felt like moving a rectangle instead
     of laying out a room. Every tile the gesture snaps through now ticks. Rate-limited, because a
     fast drag crosses tiles faster than a cue can decay, and restricted to gestures where the SNAP
     is the point — the paint and delete brushes raster whole runs of tiles per frame and would
     machine-gun it. */
  let lastTick = 0;
  const SNAP_GESTURES = { handbelt: 1, handbranch: 1, beltreshape: 1, draw: 1, beltrun: 1, move: 1, propmove: 1, propstamp: 1, groupmove: 1, roomresize: 1 };   // (THE HAND's drags tick tile by tile too)
  function snapTick(mode) {
    if (!SNAP_GESTURES[mode]) return;
    const n = performance.now();
    if (n - lastTick < 55) return;
    lastTick = n;
    sfx('tick');
  }

  // placeable props — drawn in WORLD tile coords (camera maps world*t, the bake is origin-shifted
  // to match). Lit (work=true) so the editor previews screens alive; y-sorted for clean overlap.
  let frameBayLabels = [], framePropLights = [];
  function drawProps(now) {
    frameBayLabels = [];
    framePropLights = [];
    if (typeof PropSprites === 'undefined') return;
    const list = station.props();
    if(PropSprites.setSurfaceLayout)PropSprites.setSurfaceLayout(list);
    if (!list.length) return;
    PropSprites.setCtx(ctx); PropSprites.setNow(now);
    // MOUNT LIFT — resolved per frame through station.mountOf, the SAME seam world.js draws through.
    // BUILD MODE is where props are actually placed, so a table-top prop that only lifted in the live world
    // looked, in the one view you judge it from, like it had been dropped INSIDE the table.
    // Authored mounts sort after their whole host, including children on a deep table's far row.
    // …resolved ONCE PER EDIT, not per frame: mountOf is O(props) inside the model (a propById find
    // plus a surface-host scan), so asking it for every prop every frame was O(props²) at 60fps —
    // and the map+sort it fed allocated two arrays a frame for an order that cannot change without a
    // station.onChange. The wrapper object for a MOUNTED prop is still built per frame (as before),
    // so PropSprites keeps reading the live prop, never a snapshot of it.
    /* VIEWPORT CULL. Measured 2026-08-08: on a 337-prop floor the props layer was 28.8ms of a 32ms
       frame — PropSprites renders every prop procedurally, every frame, with no offscreen cache. A
       prop entirely off the glass paints nothing, so the frame owes it nothing; culling changes what
       is DRAWN by zero pixels. The pad is deliberately generous (prop art anchors to its footprint
       bottom and rises well above it — crowns, halos, the mount lift), so nothing can clip in at the
       top edge as you pan. Zoomed all the way out to the whole station nothing is culled and the
       cost is unchanged — which is the honest worst case, and exactly what the bench reports. */
    const order = propDrawOrder(list);
    // The editor uses the same silhouette contact shadows as the live world.
    // Surface-mounted objects keep their no-floor-shadow rule.
    const tp = T(), zt = zoom * tp;
    const vx0 = (-panX) / zt - PROP_CULL_PAD, vy0 = (-panY) / zt - PROP_CULL_PAD;
    const vx1 = (cv.width - panX) / zt + PROP_CULL_PAD, vy1 = (cv.height - panY) / zt + PROP_CULL_PAD;
    if(PropSprites.drawShadow)for(const p of order){
      if(p.x>vx1||p.y>vy1||p.x+(p.w||1)-1<vx0||p.y+(p.h||1)-1<vy0)continue;
      PropSprites.drawShadow(p,mountMap.get(p.id)||null);
    }
    let bayNames = null;   // aid -> name, resolved once per paint (the roster read is a callback into app.js)
    for (const p of order) {
      const m = mountMap.get(p.id);
      let dp = m ? Object.assign({}, p, { mount: m }) : p;
      if (PropSprites.lightOf && cacheGeo) {
        // Light can reach into the viewport even when the emitting sprite is culled.
        const l = PropSprites.lightOf(dp, true, true), o = cacheGeo.origin;
        if (l) framePropLights.push(Object.assign({}, l, { x: l.x - o.tx * tp, y: l.y - o.ty * tp,
          originX: (p.x + (p.w || 1) / 2 - o.tx) * tp, originY: (p.y + (p.h || 1) / 2 - o.ty) * tp }));
      }
      if (p.x > vx1 || p.y > vy1 || p.x + (p.w || 1) - 1 < vx0 || p.y + (p.h || 1) - 1 < vy0) continue;
      // the editor draws the same gantry plate the live world does: a bound bay wears its agent's NAME
      if (p.t === 'bay' && p.agentId) {
        if (!bayNames) { bayNames = new Map(); for (const a of ((opts && typeof opts.agents === 'function' && opts.agents()) || [])) bayNames.set(a.id, a.name); }
        const nm = bayNames.get(p.agentId);
        if (nm) dp = Object.assign(dp === p ? Object.assign({}, p) : dp, { dockName: nm });
        frameBayLabels.push(dp);
      }
      const land = landings.size ? landState(p.id, now) : null;
      const lift = !land && tool === 'select' && !drag && hoverPropId === p.id ? -1.5 : 0;   // a hovered prop rises a hair: it can be picked up
      if (land || lift) {
        ctx.save(); ctx.translate(0, land ? land.dy : lift); if (land) ctx.globalAlpha = land.a;
        try { PropSprites.draw(dp, true); } finally { ctx.restore(); }
      } else PropSprites.draw(dp, true);
    }
    drawVanishing(now);
  }
  /* 4 tiles = 48px at TILE 12. The worst upward overshoot in the whole prop catalog is 21px above a
     prop's footprint top (masts/crowns; measured over propsprites.js), and SURFACE_RISE adds a few
     more — so the pad is better than double the art that can ever hang outside a footprint. */
  const PROP_CULL_PAD = 4;
  /* EVERY PROP THE FLOOR HOLDS IS IN THE DRAW LIST (2026-10-13, Andrew: a new INBOX on the floor, its gold outline drawn, its body
     not). The sorted list is memoized per edit (geoVer) and the outline reads the model directly, so a prop that reached the model
     without the version moving would be outlined and never drawn — or picked. Whatever the edit path, the memo is the model's list
     only while it IS that list at that length: the same array (an undo hands in a new one) and the same count (an add pushes). Two
     compares a frame; a recompute only when they disagree. */
  let mountList = null, mountLen = -1;
  function propDrawOrder(list) {
    if (mountVer === geoVer && mountOrder && mountList === list && mountLen === list.length) return mountOrder;
    mountVer = geoVer; mountList = list; mountLen = list.length;
    const mounts = new Map();
    for (const p of list) {
      let m = null;
      try { m = station.mountOf ? station.mountOf(p) : null; } catch (_) { m = null; }
      if (m) mounts.set(p.id, m);
    }
    // Authored placement supplies host-relative pixel depth; this list sorts in tiles.
    // Uncalibrated mounts retain their existing offset and saved-field fallback.
    // FLOOR DECALS (catalog `flat`: rug / cable run / hazard pad) sort BELOW the whole floor: they are
    // deck paint, and anything placed on them must draw on top (the same floor pass world.js runs, in
    // the form this sorted list can express). -1e6 is unreachable by a real footprint key.
    const flatOf = p => { const s = PropSprites.spec(p.t); return !!(s && s.flat); };
    const key = p => {
      if (flatOf(p)) return -1e6;
      const mounted = mounts.get(p.id) || p.mount;
      const placement = mounted === 'surface' && PropSprites.surfacePlacement
        ? PropSprites.surfacePlacement({...p,mount:mounted}) : null;
      if (placement && placement.authored && Number.isFinite(placement.sortY)) return placement.sortY / PropSprites.TILE;
      return p.y + (p.h || 1) + (mounted ? 0.5 : 0);
    };
    const arr = list.slice().sort((a, b) => key(a) - key(b));   // stable, and never touches doc.props
    mountMap = mounts;
    return (mountOrder = arr);
  }

  // conveyor — belts (floor machinery) + the live transport sim. WORLD coords like drawProps.
  function drawConveyor(now, t) {
    if (!convey) return;
    const belts = beltsMemoed();   // one array per EDIT, shared read-only by tick / ghost.tick / drawBelts
    const dt = lastFrameTs ? (now - lastFrameTs) : 16; lastFrameTs = now;
    // route the preview boxes through the SAME junctions the compiled plan uses, so a TEST box sorts exactly as
    // real work will (build-time "does my routing work?" loop). null until a junction exists -> boxes go straight.
    // Junction keys are LOCAL-frame (valPlan compiles from cacheGeo) — REBASE them to the WORLD tiles the
    // preview belts use, or junctions silently never trigger off-origin (the frame-drift bug class).
    /* The rebase + junctionLaneOwners() ran EVERY FRAME even though both inputs — the compiled plan
       and the bake origin — only move on a recompile. Memoize on exactly those two: valPlan is
       replaced (never mutated) by rebake()'s compile, so object identity is the honest key. */
    let jmap = null;
    if (valPlan && valPlan.junctions && cacheGeo) {
      const o = cacheGeo.origin || { tx: 0, ty: 0 };
      if (jmapPlan === valPlan && jmapOx === o.tx && jmapOy === o.ty) {
        jmap = jmapMemo;
      } else {
        const owners = (typeof Pipeline !== 'undefined' && Pipeline.junctionLaneOwners) ? Pipeline.junctionLaneOwners(valPlan) : {};
        for (const k in valPlan.junctions) {
          const p = k.split(','), wk = (+p[0] + o.tx) + ',' + (+p[1] + o.ty);
          (jmap = jmap || new Map()).set(wk, owners[k] ? Object.assign({}, valPlan.junctions[k], { owners: owners[k] }) : valPlan.junctions[k]);
        }
        jmapPlan = valPlan; jmapOx = o.tx; jmapOy = o.ty; jmapMemo = jmap;
      }
    }
    convey.tick(dt, now, belts, jmap, testStops());   // stops: preview crates are consumed at their dock, like real ones
    /* GHOST PROJECTION (Phase 3): stands down while anything coach-like is up (tutorial, the
       first-run card, an ARMED/pending first ride — the two narrations must never fight) and the
       INSTANT any real preview crate rides (▸ PREVIEW / the first ride own the belt). Same belts,
       same junction decisions, same frame as the real sim; its own dedicated engine + stops. */
    if (ghost) {
      const blocked = buildGroup !== 'workflow' || tutorialCoaching() || ridePending || !!rideTimer
        || !!(root && root.querySelector('.refit-firstrun')) || convey.boxCount() > 0;
      const feed = (opts && opts.world && opts.world.feedState) ? opts.world.feedState() : { known: false, fed: false };
      // the ghost is the WOULD-voice: its splits carry the once-crewed mode (the live sim keeps the real plan's)
      const fo = jmap ? fanoutOnceCrewed() : null;
      if (ghostMapFor !== jmap || ghostMapFo !== fo) {   // rebuilt only when the plan (or its once-crewed read) changes — never per frame
        ghostMapFor = jmap; ghostMapFo = fo; ghostMap = jmap;
        if (jmap && fo) { const o = cacheGeo.origin || { tx: 0, ty: 0 }; for (const k in fo) if (fo[k]) { const q = k.split(','), wk = (+q[0] + o.tx) + ',' + (+q[1] + o.ty), j = jmap.get(wk); if (j && !j.fanout) { if (ghostMap === jmap) ghostMap = new Map(jmap); ghostMap.set(wk, Object.assign({}, j, { fanout: true })); } } }
      }
      ghost.tick(dt, now, belts, ghostMap, { blocked, feed, fedLines: opts && opts.world && opts.world.fedLines ? opts.world.fedLines(valPlan) : Pipeline.fedLineIds(valPlan) });
    }
    convey.drawBelts(ctx, now, t, belts, valLive);
    /* DROP IT ON A BELT (2026-09-27 audit P5): with a junction in hand, every belt tile it can go on wears a crisp dashed
       edge — drawn geometry, never a glow — so the shelf's "drop it ON a belt" points at something on the floor. */
    if (placingProp() && JUNCTION_TAG_TYPES[propType] && belts.length) {
      const ins = 1.5 / zoom;
      ctx.save();
      ctx.strokeStyle = 'rgba(95,216,255,0.6)'; ctx.lineWidth = 1 / zoom; ctx.setLineDash([3 / zoom, 2 / zoom]);
      for (const b of belts) ctx.strokeRect(b.x * t + ins, b.y * t + ins, t - ins * 2, t - ins * 2);
      ctx.restore();
    }
  }
  function drawConveyorBoxes(now, t) {
    if (!convey) return;
    convey.drawBoxes(ctx, now, t); drawTestNotes(now, t);
    // projection + WOULD-captions over the real layer — captions go THROUGH the arbiter
    // (ghostCaption layer: mutes whenever any other voice speaks or the pointer rides the floor)
    if (ghost && buildGroup === 'workflow') ghost.draw(ctx, now, t, capFs(), (box, paint) => voiceSay('ghostCaption', box, box, paint), ghostCaptionFit);
  }
  /* A WOULD-caption in BUILD MODE keeps the live floor's law (GhostLine.onStation, review 10-14): in its own room, every part
     over the station — never across the hull into space — and beside the machine its "HERE" names, slid onto the visible
     glass by captionFit. It never covers a bay's name plate either (world.js captionInStation refuses the live floor's plates
     the same way): the gantry plate PropSprites.drawBayNames paints this frame for every bound bay drawProps listed — centred
     on the bay, straddling its top edge, 11px tall. A spot that fails answers null, so ghostline.js tries the caption's next
     spot (and with none clear it sits the pass out). */
  function ghostCaptionFit(box, n) {
    const t = T(), b = GhostLine.onStation(box, n, buildRoomBoxes(), t, bx => { captionFit(bx); return true; });
    if (!b) return null;
    for (const p of frameBayLabels) {
      const w = Math.max(12, (p.w || 1) * t - 1), cx = (p.x + (p.w || 1) / 2) * t, top = p.y * t + 1 - 5.5;
      if (b.x < cx + w / 2 && b.x + b.w > cx - w / 2 && b.y < top + 11 && b.y + b.h > top) return null;
    }
    return b;
  }
  // the floor's rooms in BUILD MODE's tile frame (the compiler's local rects + the bake origin, like the ghost's own offset)
  let buildRoomMemo = [], buildRoomGeo = null;
  function buildRoomBoxes() {
    if (!cacheGeo || !cacheGeo.allRects || typeof GhostLine === 'undefined' || !GhostLine.roomBoxes) return [];
    if (buildRoomGeo !== cacheGeo) {
      const o = cacheGeo.origin || { tx: 0, ty: 0 };
      buildRoomGeo = cacheGeo;
      buildRoomMemo = GhostLine.roomBoxes(cacheGeo.allRects, T(), o.tx, o.ty, (typeof StationBake !== 'undefined' && StationBake.WALL && StationBake.WALL.up) || 0);
    }
    return buildRoomMemo;
  }

  /* THE GUIDANCE LIVES WHERE THE HANDS ARE (2026-07-05 playtest): callouts render INSIDE build mode, in
     plain words that name the fix, at a size you can read while placing — the same visual language as the
     live world's nags (corner brackets + VT323 phosphor), not the old 7px whisper. All plan-derived
     coordinates are LOCAL-frame (valPlan compiles from cacheGeo) and are REBASED by cacheGeo.origin here,
     which kills the frame-drift bug that misplaced ghosts on off-origin floors.
     Red = blocking (loop / no default lane / dup agent / dry intake); amber = fixable advice. */
  /* ---------- THE ONE-VOICE LABEL ARBITER (2026-08-05 interaction reshape) ----------
     Every floating-text layer on the BUILD MODE canvas REGISTERS its labels here instead of painting
     directly; the arbiter draws once per frame, after every producer has spoken. The law it
     enforces (Andrew's "clusterfuck of text" verdict): AT MOST one label per anchor region, and a
     lower layer is muted entirely wherever a higher one is live nearby (collision = overlapping
     label rects OR overlapping anchors).
       priority: activeFlow (connect gesture / test-ride captions)
               > float (THE HAND's short REMOVED / UNDID / SELECTED / PASTED, while it rises)
               > hover (the machine under the pointer)
               > topNag (validation callouts — real problems)
               > ghostCaption (the projection's WOULD-voice)
               > rolePlacard (an unbound role dock introducing itself)
     Ghost captions additionally mute while ANY other layer speaks anywhere, or while the pointer
     is over the floor (the user is looking at machines, not the projection).
     All rects are WORLD px (the frame's zoom/pan transform is live at flush time). */
  const LAYER_PRI = { activeFlow: 5, float: 4.5, hover: 4, topNag: 3, ghostCaption: 2, rolePlacard: 1, junctionTag: 0.5 };   // float: THE HAND's REMOVED / UNDID / SELECTED / PASTED
  const voiceReqs = [];
  function voiceBegin() { voiceReqs.length = 0; }
  // anchor = the machine/tile the label speaks about; box = the label's own rect; draw paints it
  function voiceSay(layer, anchor, box, draw) { voiceReqs.push({ layer, pri: LAYER_PRI[layer] || 0, anchor, box, draw }); }
  const voiceHit = (a, b, pad) => !!(a && b) && a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
  function voiceFlush(overFloor) {
    if (!voiceReqs.length) return;
    const othersSpeak = voiceReqs.some(r => r.layer !== 'ghostCaption');
    const pad = 4 / zoom;   // world-px breathing room between voices
    const live = voiceReqs.filter(r => r.layer !== 'ghostCaption' || (!othersSpeak && !overFloor));
    live.sort((a, b) => b.pri - a.pri);   // stable: within a layer, registration order holds
    const placed = [];
    for (const r of live) {
      if (placed.some(p => voiceHit(r.box, p.box, pad) || voiceHit(r.anchor, p.anchor, 0))) continue;
      placed.push(r);
      if (r.draw) r.draw(ctx);
    }
  }

  const VAL_FONT = () => Math.max(9, 11 / zoom) + "px 'VT323','Courier New',monospace";
  /* LABEL COLLISION (2026-07-11): callouts are laid out, not just painted — neighboring findings on one
     row (or two findings on the SAME prop) used to print on a shared baseline and mash into garble
     ("NO COMPUT|NOT ADD THPC..."). Each label claims a box; a collider steps AWAY from the prop (up for
     above-labels, down for below-labels) one line at a time until it fits. Cleared per frame. */
  function placeLabel(placed, cx, y, w, h, dir) {
    const hits = b => cx - w / 2 < b.x + b.w && cx + w / 2 > b.x && y < b.y + b.h && y + h > b.y;
    let guard = 24;
    while (guard-- > 0 && placed.some(hits)) y += dir * (h + 1);
    placed.push({ x: cx - w / 2, y, w, h });
    return y;
  }
  // the role placard for an UNBOUND role-carrying dock: "RESEARCHER — DIGS SOURCES… — CLICK".
  // One string builder shared by BUILD MODE's validation callout and the live world's nag (world.js
  // mirrors it through the same WorldModel.bayRoleInfo source so the two never drift).
  function roleLabelFor(p) {
    if (!p || !p.role || p.agentId) return null;
    const ri = (typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(p.role) : null;
    return ri ? p.role + ' — ' + ri.desc.toUpperCase() + ' — CLICK' : null;
  }
  /* HIDDEN HOOKUPS MADE VISIBLE (2026-09-23 playtest). The compiler hooks a machine to every belt tile in its
     1-tile ring, corners included. When ONE such tile sits in the rings of two machines and points into /
     out of only one of them, the other is hooked too — two bays stacked touching became a hand-off chain,
     a line stamped under another joined it. The routing rule stands; what changes is that the floor SHOWS
     it: every such "brushed" hookup gets a small amber tap arrow from the belt into the machine it brushes,
     and the machine's hover card says it in words. Pure over the doc, once per floor edit (geoVer). */
  let brushVer = 0, brushMemo = null;
  function brushedHookups() {
    if (brushVer === geoVer && brushMemo) return brushMemo;
    brushVer = geoVer; brushMemo = [];
    if (!station) return brushMemo;
    const DV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    const docks = station.props().filter(p => CONNECT_TYPES[p.t] && ((p.w || 1) > 1 || (p.h || 1) > 1));
    const inFoot = (p, x, y) => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1);
    const owners = new Map();
    for (const p of docks)
      for (let y = p.y - 1; y <= p.y + (p.h || 1); y++) for (let x = p.x - 1; x <= p.x + (p.w || 1); x++) {
        if (inFoot(p, x, y) || !station.beltAt(x, y)) continue;
        const k = x + ',' + y; if (!owners.has(k)) owners.set(k, []); owners.get(k).push(p);
      }
    for (const [k, ps] of owners) {
      if (ps.length < 2) continue;
      const q = k.split(','), x = +q[0], y = +q[1], d = DV[station.beltAt(x, y)] || null;
      // FACES = the belt visibly enters the machine (arrow into it) or leaves it (the tile behind is the machine)
      const faces = p => !!d && (inFoot(p, x + d[0], y + d[1]) || inFoot(p, x - d[0], y - d[1]));
      for (const p of ps) if (!faces(p)) brushMemo.push({ x, y, propId: p.id, p });
    }
    return brushMemo;
  }
  function drawBrushedHookups(t) {
    const list = brushedHookups();
    if (!list.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,190,60,0.95)'; ctx.fillStyle = 'rgba(255,190,60,0.95)'; ctx.lineWidth = 2 / zoom;
    for (const h of list) {
      const p = h.p, cx = (h.x + 0.5) * t, cy = (h.y + 0.5) * t;
      // the nearest point of the machine's footprint — the tap lands on its edge
      const tx2 = Math.max(p.x * t, Math.min((p.x + (p.w || 1)) * t, cx)), ty2 = Math.max(p.y * t, Math.min((p.y + (p.h || 1)) * t, cy));
      const dx = tx2 - cx, dy = ty2 - cy, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, a = t * 0.22;
      ctx.beginPath(); ctx.arc(cx, cy, t * 0.14, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx2, ty2);
      ctx.moveTo(tx2 - ux * a - uy * a * 0.7, ty2 - uy * a + ux * a * 0.7); ctx.lineTo(tx2, ty2); ctx.lineTo(tx2 - ux * a + uy * a * 0.7, ty2 - uy * a - ux * a * 0.7);
      ctx.stroke();
    }
    ctx.restore();
  }
  /* JUNCTION NAME TAGS (2026-09-27 audit P1/P2). The five 1×1 junctions share one size and read as belt pieces, and a splitter's
     mode (a copy to every branch, or turns) was decided by a JOINER somewhere downstream with nothing on the splitter saying so.
     The junction under the pointer (or selected) wears a short tag UNDER its tile: what it is and what it will do, read from the
     COMPILED cfg (the same fact the sidecar routes by). Only one at a time — a tag on every junction at rest was the "wall of
     text" the one-voice law exists to stop; the Workflow panel carries the same facts for the whole line. */
  const JUNCTION_TAG_TYPES = { splitter: 1, joiner: 1, merger: 1, filter: 1, loop: 1 };
  const RING_DOCK_T = { bay: 1, intake: 1, outbox: 1 };   // machines that hook belts through a 1-tile ring (the spacing tip)
  /* A SPLIT'S MODE ONCE CREWED (2026-09-27): the compiler marks a split fan-out only when a crewed branch reaches its JOINER,
     so on a freshly stamped line (no agents yet) every split read TAKES TURNS — while the Workflow panel's strip (which compiles
     with a stand-in agent on each uncrewed bay) said ALL RUN, and the ghost said "jobs would take turns". The WOULD-voices (the
     ghost, the tags, the card, the panel section) all read this: the real plan where every bay is crewed, the probe compile where
     some are not. Keyed by LOCAL junction tile; memoized per compiled plan. */
  let fanoutMemo = null, fanoutPlan = null;
  let ghostMap = null, ghostMapFor = null, ghostMapFo = null;   // the ghost's junction map (the live one + once-crewed split modes)
  // the floor compiled as if every BAY had an agent — what the line WILL do once crewed (the real plan when all are crewed)
  let probePlanFor = null, probePlanMemo = null;
  function probePlanOnceCrewed() {
    if (!valPlan || !cacheGeo) return null;
    if (probePlanFor === valPlan) return probePlanMemo;
    let out = valPlan;
    const props = cacheGeo.props || [];
    if (typeof Pipeline !== 'undefined' && Pipeline.compileRoutingPlan && props.some(p => p.t === 'bay' && !p.agentId)) {
      try { out = Pipeline.compileRoutingPlan(Object.assign({}, cacheGeo, { props: props.map(p => (p.t === 'bay' && !p.agentId) ? Object.assign({}, p, { agentId: '__probe_' + p.id }) : p) })); }
      catch (e) { out = valPlan; /* the real plan's answer stands */ }
    }
    probePlanFor = valPlan; probePlanMemo = out;
    return out;
  }
  function fanoutOnceCrewed() {
    if (!valPlan || !cacheGeo) return {};
    if (fanoutPlan === valPlan && fanoutMemo) return fanoutMemo;
    const out = {};
    for (const k in (valPlan.junctions || {})) if (valPlan.junctions[k].kind === 'split') out[k] = !!valPlan.junctions[k].fanout;
    const probe = probePlanOnceCrewed();
    if (probe && probe !== valPlan) for (const k in (probe.junctions || {})) if (probe.junctions[k].kind === 'split' && probe.junctions[k].fanout) out[k] = true;
    fanoutPlan = valPlan; fanoutMemo = out;
    return out;
  }
  /* THE SPLITTER'S MODE, AS A CHOICE (2026-09-28 — "make hidden behavior an explicit choice"). A split COPIES when a
     JOINER is where its branches meet and TAKES TURNS when a MERGER is; the switch swaps that one junction in place
     (worldmodel.swapJoinerMerger — same tile, same belts, one undo). Read on the once-crewed plan, so a freshly stamped
     line answers the same as a crewed one. A choice the floor cannot make says why instead of half-doing it. */
  function splitModeInfo(splitId) {
    const p = station && station.propById(splitId);
    if (!p || p.t !== 'splitter' || typeof Pipeline === 'undefined' || !Pipeline.rejoinOf) return null;
    const jt = junctionBeltTile(p), o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
    const lk = jt ? (jt.x - o.tx) + ',' + (jt.y - o.ty) : null;
    const plan = probePlanOnceCrewed();
    if (!lk || !plan || !plan.junctions || !plan.junctions[lk]) return null;
    const copies = !!fanoutOnceCrewed()[lk];
    const lanes = Pipeline.rejoinOf(plan, lk).lanes;
    const propAt = k => { const q = String(k).split(','), x = +q[0] + o.tx, y = +q[1] + o.ty; const hit = station.props().find(r => (r.t === 'joiner' || r.t === 'merger') && r.x === x && r.y === y); return hit ? hit.id : null; };
    const meet = lanes.length > 1 && lanes.every(l => l.at && l.at === lanes[0].at) ? lanes[0] : null;
    const joins = [...new Set(lanes.filter(l => l.kind === 'join').map(l => propAt(l.at)).filter(Boolean))];
    /* SPLIT THE JOB (2026-10-10): the copying split's third reading — the step before the splitter writes the job as parts and
       each branch gets only its own. It needs what COPY needs (a JOINER where the branches meet, swapped in from a MERGER) plus
       a step BEFORE the splitter to write the parts; with none, the switch adds a PLANNER there (the INBOX can't divide). */
    const divides = copies && !!plan.junctions[lk].divide;
    const toTurns = copies
      ? (joins.length ? { ok: true, swap: joins } : { ok: false, msg: 'a JOINER further down the line combines these branches — make that one a MERGER to let them take turns' })
      : { ok: true, already: true };
    const noSecond = { ok: false, msg: 'run a second belt OUT of the splitter first: drag from the SPLITTER onto the next machine' };
    const toCopy = !copies
      ? (lanes.length < 2 ? noSecond
        : meet && meet.kind === 'merge' && propAt(meet.at) ? { ok: true, swap: [propAt(meet.at)] }
        : { ok: false, msg: 'the branches never meet at one MERGER — belt them into one JOINER where they come back together (the JOINER on the hotbar, key 6)' })
      : divides ? { ok: true, swap: [] } : { ok: true, already: true };
    let toDivide = divides ? { ok: true, already: true } : toCopy.already ? { ok: true, swap: [] } : toCopy.ok ? { ok: true, swap: toCopy.swap } : toCopy;
    if (toDivide.ok && !toDivide.already && !(Pipeline.splitFedByDock && Pipeline.splitFedByDock(plan, lk))) {
      // nothing but the INBOX feeds the splitter: a PLANNER step goes in on the belt that does
      let from = null;
      try { const g = station.lineGraph(splitId); const inl = g && g.ok ? g.graph.links.filter(l => l.to && l.to.node === splitId) : []; if (inl.length === 1) from = inl[0].from.node; } catch (e) { from = null; }
      toDivide = from ? Object.assign({}, toDivide, { addLead: from }) : { ok: false, msg: 'put a step (a BAY) on the belt into the splitter first — it writes the parts each branch gets' };
    }
    return { mode: divides ? 'divide' : copies ? 'copy' : 'turns', toCopy, toTurns, toDivide };
  }
  function setSplitMode(splitId, mode) {
    const info = splitModeInfo(splitId);
    if (!info) return { ok: false, msg: 'this splitter is not on a line yet' };
    const step = mode === 'divide' ? info.toDivide : mode === 'copy' ? info.toCopy : info.toTurns;
    if (step.already) return { ok: true, already: true };
    if (!step.ok) return { ok: false, msg: step.msg };
    const sp = station.propById(splitId), dividing = !!(sp && sp.divide);
    // ONE UNDO for the whole switch: the JOINER/MERGER swap, a PLANNER step when SPLIT THE JOB needs one, and the flag
    const res = station.transact(() => {
      for (const id of step.swap) { const r = station.swapJoinerMerger(id); if (!r.ok) return r; }
      if (mode === 'divide' && step.addLead) {
        const r = lineEditRun('insertStep', step.addLead, { from: step.addLead, to: splitId, role: 'PLANNER' });
        if (!r || !r.ok) return { ok: false, msg: (r && (r.msg || r.error)) || 'there is no room for a PLANNER step before the splitter' };
      }
      if ((mode === 'divide') !== dividing) { const r = station.setSplitDivide(splitId, mode === 'divide'); if (!r.ok) return r; }
      return { ok: true };
    }, mode === 'divide' ? 'SPLIT THE JOB' : 'SPLITTER');   // (the undo says what it took back — setSplitDivide's own label is skipped in a batch)
    if (res && res.ok) { try { rebake(); } catch (e) { /* the frame loop recompiles */ } }
    return res && res.ok ? { ok: true, mode } : { ok: false, msg: (res && (res.msg || res.error)) || 'could not switch' };
  }
  function junctionTagText(p) {
    const jp = probePlanOnceCrewed() || valPlan, cfg = (jp && jp.junctions && jp.junctions[p.x + ',' + p.y]) || null;
    if (p.t === 'splitter') return cfg ? (cfg.divide ? 'SPLITTER · SPLITS THE JOB' : fanoutOnceCrewed()[p.x + ',' + p.y] ? 'SPLITTER · COPY TO EACH' : 'SPLITTER · TAKES TURNS') : 'SPLITTER';
    if (p.t === 'joiner') return cfg && cfg.expect > 1 ? 'JOINER · WAITS FOR ' + cfg.expect : 'JOINER · WAITS';
    if (p.t === 'loop') return 'LOOP · UP TO ' + ((cfg && cfg.max) || (typeof Pipeline !== 'undefined' && Pipeline.LOOP_MAX_DEFAULT) || 5) + '×';
    if (p.t === 'filter') return 'FILTER · SORTS';
    if (p.t === 'merger') return 'MERGER · SHARES';
    return null;
  }
  const TAG_FONT = () => Math.max(6, 8 / zoom) + "px 'VT323','Courier New',monospace";
  function drawJunctionTags(t) {
    if (!cacheGeo || buildGroup !== 'workflow' || !valPlan) return;
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, fh = Math.max(6, 8 / zoom);
    ctx.save(); ctx.font = TAG_FONT();
    for (const p of (cacheGeo.props || [])) {
      if (!JUNCTION_TAG_TYPES[p.t] || (p.id !== hoverPropId && p.id !== selectedPropId)) continue;
      const text = junctionTagText(p); if (!text) continue;
      const X = (p.x + o.tx) * t, Y = (p.y + o.ty) * t, tw = ctx.measureText(text).width;
      const bx = X + t / 2 - tw / 2, by = Y + t + 2 / zoom;
      voiceSay('junctionTag', { x: X, y: Y, w: t, h: t }, { x: bx - 2 / zoom, y: by - 1 / zoom, w: tw + 4 / zoom, h: fh + 2 / zoom }, c => {
        c.save(); c.font = TAG_FONT(); c.textAlign = 'center'; c.textBaseline = 'top';
        c.globalAlpha = 0.9; c.fillStyle = 'rgba(3,2,1,.74)'; c.fillRect(bx - 2 / zoom, by - 1 / zoom, tw + 4 / zoom, fh + 2 / zoom);
        c.fillStyle = '#86dcff'; c.shadowBlur = 2; c.shadowColor = '#3ab8ff';
        c.fillText(text, X + t / 2, by);
        c.restore();
      });
    }
    ctx.restore();
  }
  function drawRoutingValidation(t, now) {
    if (!cacheGeo) return;
    // Dormant workflows do not ask for attention while furnishing or shaping rooms.
    if (buildGroup !== 'workflow' && !tutorialCoaching()) return;
    drawBrushedHookups(t);   // no text — a hidden hookup is shown whenever the Conveyors tab is up
    if (!finEngaged && tool !== 'belt' && tool !== 'line' && !tutorialCoaching()) return;
    const o = cacheGeo.origin || { tx: 0, ty: 0 };
    const pulse = 0.55 + 0.35 * Math.sin(now / 280);
    const placed = [];
    // the checklist's focused next step: its dock may speak its role placard even unhovered
    const focusDock = (finCardEl && finComp) ? (finState(finComp).unbound[0] || null) : null;
    const focusDockId = focusDock ? focusDock.propId : null;
    /* brackets always paint (a bracket is machinery marking, not text); the LABEL registers with
       the arbiter — one voice per anchor, higher layers mute this one nearby. */
    const mark = (rect, col, label, layer) => {
      // rect arrives in LOCAL tiles → draw in WORLD px (bake + props frame)
      const X = (rect.x1 + o.tx) * t, Y = (rect.y1 + o.ty) * t;
      const Wd = (rect.x2 - rect.x1 + 1) * t, Hd = (rect.y2 - rect.y1 + 1) * t;
      const L = Math.max(3, Math.floor(t / 3));
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();   // corner brackets — a machinery callout, not a selection box
      ctx.moveTo(X + .5, Y + .5 + L); ctx.lineTo(X + .5, Y + .5); ctx.lineTo(X + .5 + L, Y + .5);
      ctx.moveTo(X + Wd - .5 - L, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5 + L);
      ctx.moveTo(X + .5, Y + Hd - .5 - L); ctx.lineTo(X + .5, Y + Hd - .5); ctx.lineTo(X + .5 + L, Y + Hd - .5);
      ctx.moveTo(X + Wd - .5, Y + Hd - .5 - L); ctx.lineTo(X + Wd - .5, Y + Hd - .5); ctx.lineTo(X + Wd - .5 - L, Y + Hd - .5);
      ctx.stroke();
      ctx.restore();
      if (!label) return;
      // measure + collision-step NOW (final boxes), paint at flush if the arbiter grants the voice
      ctx.save();
      ctx.font = VAL_FONT();
      const tw = ctx.measureText(label).width;
      ctx.restore();
      // baseline-bottom label: its box spans [y-lh, y] — colliders step UP (dir -1), away from the machinery
      const lh = Math.max(9, 11 / zoom) + 2 / zoom;
      const ly = placeLabel(placed, X + Wd / 2, Y - 2 / zoom - lh, tw, lh, -1);
      voiceSay(layer || 'topNag', { x: X, y: Y, w: Wd, h: Hd }, { x: X + Wd / 2 - tw / 2, y: ly, w: tw, h: lh }, (c) => {
        c.save();
        c.globalAlpha = pulse;
        c.font = VAL_FONT(); c.textAlign = 'center'; c.textBaseline = 'bottom';
        c.shadowBlur = 3; c.shadowColor = col; c.fillStyle = col;
        c.fillText(label, X + Wd / 2, ly + lh);
        c.restore();
      });
    };
    // routing findings from the compiled plan — every label names the FIX (see VAL_LABEL)
    if (valPlan && valPlan.errors && valPlan.errors.length) {
      const propById = {};
      for (const p of (cacheGeo.props || [])) propById[p.id] = p;
      for (const e of valPlan.errors) {
        let rect = null;
        if (e.tile) rect = { x1: e.tile.x, y1: e.tile.y, x2: e.tile.x, y2: e.tile.y };
        else if (e.propId && propById[e.propId]) { const p = propById[e.propId]; rect = { x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }; }
        if (!rect) continue;
        let label = VAL_LABEL[e.code] || e.code, layer = 'topNag';
        // THE HAND (H5): an over-budget INBOX says its n/max on the floor — the one resting number — in the same voice that names the fix
        if (e.code === 'LINE_TOO_LONG' && e.stages > 0) label = 'TOO LONG ' + e.stages + '/' + (e.maxHops + 1) + ' — RAISE THE BUDGET';
        /* a ROLE-carrying unbound dock is a PLACARD, not a permanent nag (one-voice law): it speaks
           only while hovered or while it is the checklist's focused next step — at rest the amber
           bracket + the FINISH-THE-LINE card already carry the story. Roleless unbound bays keep
           the short topNag (there is no card walking the user to them). */
        if (e.code === 'UNBOUND_BAY' && e.propId) {
          const rl = roleLabelFor(propById[e.propId]);
          if (rl) {
            layer = 'rolePlacard';
            label = (hoverPropId === e.propId || focusDockId === e.propId) ? rl : null;
          }
        }
        mark(rect, e.warn ? '#ffbe3c' : '#ff5046', label, layer);   // amber warn vs red blocker
      }
    }
    // B5 cost-safety: a BOUND bay whose room has no dedicated PC can't run routed work — the compute gate
    // stays shut. Surface it (amber) so the Commander equips the bay while still IN build mode.
    if (typeof station.bayObjects === 'function') {
      for (const p of (cacheGeo.props || [])) {
        if (p.t !== 'bay' || !p.agentId) continue;
        // memoized per (agentId, geoVer) and guarded — see bayObjectsMemoed. This ran BARE, per bay,
        // per frame, and each call is O(props × rooms) inside the model.
        if (bayObjectsMemoed(p.agentId, p.id).indexOf('computer') >= 0) continue;   // THIS bay's run, not the agent's first
        mark({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }, '#ffbe3c', 'NO COMPUTE — ADD A PC IN THIS ROOM');
      }
    }
    // a CONNECTOR PORTAL with no bound server grants nothing — surface it (amber) so the Commander binds one.
    for (const p of (cacheGeo.props || [])) {
      if (p.t !== 'connector_portal') continue;
      const live = station.propById(p.id);
      if (live && live.connectorId) continue;
      mark({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }, '#ffbe3c', 'NO SERVER — CLICK TO BIND');
    }
  }
  /* BELT-TOOL ENDPOINT GLOW: while the BELT tool is armed, the legal endpoints announce themselves —
     INTAKE pulses green "FROM", bound BAYs and OUTBOX pulse cyan "TO" — so "what do I connect to what"
     is answered by the floor itself before the first tile is laid. Desks never glow: belts don't run to
     workstations (the agent carries work the last leg). */
  /* THE LANE BEFORE THE CLICK (conveyor-links phase B — the plan's "port marks"): mid-connect, the hovered destination
     shows the very belt the click would lay (station.previewBelt runs the connect planner without laying), tile by tile
     with its flow — or, when it cannot, why. Once per (edit, pair). */
  let beltPvKey = '', beltPvMemo = null;
  function beltPreview(from, to) {
    if (!station || typeof station.previewBelt !== 'function') return null;
    const k = geoVer + '|' + from + '|' + to;
    if (k === beltPvKey) return beltPvMemo;
    let r = null;
    try { r = station.previewBelt(from, to); } catch (_) { r = null; }
    beltPvKey = k; beltPvMemo = r;
    return r;
  }
  const NO_ROUTE = { FROM_BLOCKED: 'NO FREE SIDE TO LEAVE FROM', TO_BLOCKED: 'NO FREE SIDE TO RUN INTO', TOO_CLOSE: 'TOO CLOSE — MOVE IT A TILE AWAY', JUNCTION_NO_IN: 'THE BELT CANNOT RUN INTO IT', JUNCTION_NO_OUT: 'THE BELT CANNOT RUN OUT OF IT' };
  function drawBeltPreview(t, pv, col) {
    const V = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    ctx.save();
    ctx.globalAlpha = 0.85; ctx.strokeStyle = col; ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([3 / zoom, 2 / zoom]);
    for (const q of pv.path) ctx.strokeRect(q.x * t + 2 / zoom, q.y * t + 2 / zoom, t - 4 / zoom, t - 4 / zoom);
    ctx.setLineDash([]);
    for (const q of pv.path) {   // a chevron the way the belt will flow
      const v = V[q.d] || V.E, cx = q.x * t + t / 2, cy = q.y * t + t / 2, r = t * 0.22;
      ctx.beginPath();
      ctx.moveTo(cx - v[0] * r - v[1] * r, cy - v[1] * r + v[0] * r);
      ctx.lineTo(cx + v[0] * r, cy + v[1] * r);
      ctx.lineTo(cx - v[0] * r + v[1] * r, cy - v[1] * r - v[0] * r);
      ctx.stroke();
    }
    ctx.restore();
  }
  /* ---------- SEND TO (2026-10-10) — one line hands its finished work on to another ----------
     The OUTBOX carries `sendTo` (worldmodel setSendTo): a POINTER to the next line's INBOX, never a belt — belts joining two
     lines make one line (the 10-09 P0). Three ways to set it, ONE verdict (station.sendToRefusal — the same words on the ghost
     and at the drop): drag the OUTBOX onto another line's INBOX (SELECT), the BELT tool's two clicks (the OUTBOX, then that
     INBOX), or the Workflow panel's SEND TO chips. On the floor it is a dashed arc from the OUTBOX to the INBOX it feeds — green
     while the compiled plan carries it, red while a finding has it off (the nag says why); its words only on hover/selection. */
  let sendPvKey = null, sendPvMemo = null;
  function sendToPv(fromId, toId) {
    if (!station || typeof station.sendToRefusal !== 'function') return null;
    const k = geoVer + '|' + fromId + '|' + toId;
    if (k === sendPvKey) return sendPvMemo;
    let r = null;
    try { const no = station.sendToRefusal(fromId, toId); r = no || { ok: true, name: sendName(toId) }; } catch (_) { r = null; }
    sendPvKey = k; sendPvMemo = r;
    return r;
  }
  // a line as the floor names it, by its INBOX (the line's name rides the INBOX label)
  function sendName(intakeId) {
    const ip = station.propById(intakeId);
    return ip ? lineWordOf(ip) : 'A REMOVED LINE';
  }
  function commitSendTo(outboxId, intakeId, ev) {
    const r = typeof station.setSendTo === 'function' ? station.setSendTo(outboxId, intakeId) : null;
    const o = station.propById(outboxId), ip = intakeId ? station.propById(intakeId) : null;
    if (r && r.ok) {
      sfx('chime');
      flashTip(ev, ip ? 'SENDS TO ' + sendName(ip.id) + ' — each job that finishes cleanly here starts a job on it' : 'SENDS NOWHERE — this line’s work stops at its OUTBOX', true);
      if (o) pushFlash([propRect(o)].concat(ip ? [propRect(ip)] : []), false);
      if (o) { selectedPropId = o.id; renderSelection(); }
    } else { sfx('bad'); flashTip(ev, (r && r.msg) || 'an OUTBOX sends only to another line’s INBOX', false); }
    return r;
  }
  // the arc from an OUTBOX to the INBOX it sends to: world px, curving below the lower of the two (prototype's tube)
  function sendArc(t, a, b) {
    const ax = (a.x + (a.w || 1) / 2) * t, ay = (a.y + (a.h || 1) / 2) * t, bx = (b.x + (b.w || 1) / 2) * t, by = (b.y + (b.h || 1) / 2) * t;
    return { ax, ay, bx, by, mx: (ax + bx) / 2, my: Math.max(ay, by) + 1.6 * t };
  }
  function strokeSendArc(arc, col, now, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = 1.6 / zoom;
    ctx.setLineDash([4 / zoom, 3 / zoom]); ctx.lineDashOffset = -((now / 60) % 7) / zoom;
    ctx.beginPath(); ctx.moveTo(arc.ax, arc.ay); ctx.quadraticCurveTo(arc.mx, arc.my, arc.bx, arc.by); ctx.stroke();
    ctx.setLineDash([]);
    // the arrowhead at the INBOX: along the curve's last tangent
    const dx = arc.bx - arc.mx, dy = arc.by - arc.my, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, r = 4 / zoom + 2;
    ctx.beginPath();
    ctx.moveTo(arc.bx - ux * r - uy * r * 0.7, arc.by - uy * r + ux * r * 0.7); ctx.lineTo(arc.bx, arc.by); ctx.lineTo(arc.bx - ux * r + uy * r * 0.7, arc.by - uy * r - ux * r * 0.7);
    ctx.stroke();
    ctx.restore();
  }
  // every SEND TO on the floor, rebuilt only when the floor or the plan changes (never per frame)
  let sendLinksGeo = null, sendLinksPlan = null, sendLinksMemo = [];
  function sendLinks() {
    if (sendLinksGeo === geoVer && sendLinksPlan === valPlan) return sendLinksMemo;   // (valPlan is rebuilt only when the floor changes)
    const out = [];
    for (const p of station.props()) {
      if (p.t !== 'outbox' || !p.sendTo) continue;
      const ip = station.propById(p.sendTo);
      if (!ip) continue;
      out.push({ from: p, to: ip, live: !!(valPlan && valPlan.sendTo && valPlan.sendTo[p.id]), name: sendName(ip.id) });
    }
    sendLinksGeo = geoVer; sendLinksPlan = valPlan; sendLinksMemo = out;
    return out;
  }
  function drawSendLinks(t, now) {
    if (!station) return;
    const links = sendLinks();
    if (!links.length) return;
    /* RE-AIMED: the arc being re-aimed is hidden only while a NEW arc stands in for it — THE HAND's ghost while the drag really re-aims
       the OUTBOX (a SEND TO plan, memoized per tile), or the BELT tool armed on that OUTBOX over another INBOX it may send to
       (drawBeltEndpointGlow strokes that arc; a click there replaces this one). The OUTBOX laying a belt, MOVED (SELECT MOVES — its
       SEND TO stays after the move, and nothing else draws it), armed pointing at nothing, at its own target or at a refused INBOX
       keeps its arc (wave 2, build-13; repair: the propmove clause hid a live hand-off for the whole move, and the BELT tool's re-aim
       drew two arcs from one OUTBOX) */
    const beltAim = tool === 'belt' && connectFrom && !connectTo && hoverPropId && hoverPropId !== connectFrom ? hoverPropId : null;
    for (const s of links) {
      if (drag && drag.propId === s.from.id && drag.mode === 'handbelt' && (handPlan(drag) || {}).kind === 'send') continue;
      if (beltAim && s.from.id === connectFrom && beltAim !== s.to.id) { const hp = station.propById(beltAim), sp = hp && hp.t === 'intake' ? sendToPv(s.from.id, hp.id) : null; if (sp && sp.ok) continue; }
      const arc = sendArc(t, s.from, s.to);
      strokeSendArc(arc, s.live ? '#57bd8b' : '#d2684c', now, s.live ? 0.7 : 0.8);
      const near = altOn() || [hoverPropId, selectedPropId].some(id => id && (id === s.from.id || id === s.to.id));
      if (!near) continue;   // ONE-VOICE LAW: the arc alone at rest; its words when you look at either end (or hold Alt — every arc speaks, in its compiled colour)
      const txt = s.live ? 'SENDS TO ' + s.name : 'SEND TO ' + s.name + ' IS OFF';
      ctx.save(); ctx.font = VAL_FONT();
      const tw = ctx.measureText(txt).width, lh = Math.max(9, 11 / zoom) + 2 / zoom;
      ctx.restore();
      const cx = 0.25 * arc.ax + 0.5 * arc.mx + 0.25 * arc.bx, cy = 0.25 * arc.ay + 0.5 * arc.my + 0.25 * arc.by;
      const col = s.live ? '#57bd8b' : '#d2684c';
      voiceSay('hover', { x: cx - tw / 2, y: cy, w: tw, h: lh }, { x: cx - tw / 2, y: cy + 2 / zoom, w: tw, h: lh }, (c) => {
        c.save(); c.font = VAL_FONT(); c.textAlign = 'center'; c.textBaseline = 'top';
        c.shadowBlur = 3; c.shadowColor = col; c.fillStyle = col; c.fillText(txt, cx, cy + 2 / zoom);
        c.restore();
      });
    }
  }
  // the BELT tool armed on an OUTBOX: its one destination is another line's INBOX (a SEND TO) — what each hovered target says
  function sendRole(isFrom, p) {
    const from = connectFrom && !connectTo ? station.propById(connectFrom) : null;
    if (!from || from.t !== 'outbox') return null;
    if (isFrom) return 'SEND TO — NOW CLICK ANOTHER LINE’S INBOX';
    if (p.t !== 'intake') return null;
    const pv = sendToPv(from.id, p.id);
    return pv ? (pv.ok ? 'CLICK TO SEND TO ' + pv.name : (pv.short || pv.msg)) : null;
  }
  function drawBeltEndpointGlow(t, now) {
    if (tool !== 'belt' || !station) return;
    // the armed machine: a FROM — or, JOIN A LINE, the destination BAY (the lane then runs from the hovered machine INTO it)
    const armed = connectFrom || connectTo;
    if (armed && hoverPropId && hoverPropId !== armed) {
      const hp = station.propById(hoverPropId), pv = hp && CONNECT_TYPES[hp.t] ? (connectTo ? beltPreview(hoverPropId, connectTo) : beltPreview(connectFrom, hoverPropId)) : null;
      if (pv && pv.ok) drawBeltPreview(t, pv, '#7ee2a8');
      // an armed OUTBOX over another line's INBOX: the SEND TO arc it would make (no belt is ever laid between lines)
      const fo = connectFrom && !connectTo ? station.propById(connectFrom) : null;
      if (fo && fo.t === 'outbox' && hp && hp.t === 'intake') { const sp = sendToPv(fo.id, hp.id); strokeSendArc(sendArc(t, fo, hp), sp && sp.ok ? '#57bd8b' : '#d2684c', now, 0.95); }
    }
    const pulse = 0.45 + 0.3 * Math.sin(now / 260);
    const placed = [];
    ctx.save();
    ctx.font = VAL_FONT();
    for (const p of station.props()) {
      if (!CONNECT_TYPES[p.t]) continue;
      const isFrom = !!armed && p.id === armed;
      // mid-connect the story flips: the armed machine burns gold, every other machine reads as a target
      const from = connectFrom && station.propById(connectFrom);
      const verdict = !isFrom && hoverPropId === p.id && armed ? (from && from.t === 'outbox' && p.t === 'intake' ? sendToPv(from.id,p.id) : connectTo ? beltPreview(p.id,connectTo) : beltPreview(connectFrom,p.id)) : null;
      const col = isFrom ? '#ffd94a' : verdict && !verdict.ok ? '#ff8f80' : armed ? '#7ee2a8' : p.t === 'intake' ? '#3fd08a' : '#5ad0ff';
      const X = p.x * t, Y = p.y * t, Wd = (p.w || 1) * t, Hd = (p.h || 1) * t;
      ctx.globalAlpha = isFrom ? 0.95 : pulse;
      ctx.strokeStyle = col; ctx.lineWidth = (isFrom ? 2.5 : 1.5) / zoom;
      ctx.strokeRect(X - 1, Y - 1, Wd + 2, Hd + 2);
      /* ONE-VOICE LAW: the FROM/TO text exists ONLY while the connect flow is mid-gesture
         (connectFrom armed). At rest the pulsing outlines alone say "these are the endpoints" —
         nine simultaneous CLICK TO CONNECT / JUNCTION captions were the loudest single layer in
         Andrew's text-soup screenshot. Mid-gesture labels ride the activeFlow layer (top priority). */
      if (!armed) continue;
      /* …and mid-gesture only the HOVERED target speaks (2026-09-23 playtest: "CLICK TO CONNECT" printed over
         every target at once, a wall of the same words). The other targets keep their pulsing glow — that
         alone says "these are the endpoints"; the caption answers "this one?" where the pointer is. */
      if (!isFrom && hoverPropId !== p.id) continue;
      const pv = isFrom ? null : connectTo ? beltPreview(p.id, connectTo) : beltPreview(connectFrom, p.id);
      const role = isFrom ? (connectTo ? 'TO ▸ NOW CLICK THE MACHINE THAT HANDS IT WORK' : 'FROM ▸ NOW CLICK A DESTINATION') : (pv && !pv.ok) ? (pv.short || 'NO ROUTE — ' + (NO_ROUTE[pv.error] || 'NO CLEAR PATH')) : 'CLICK TO CONNECT';
      const said = sendRole(isFrom, p) || role;   // an armed OUTBOX speaks SEND TO (its one destination is another line's INBOX)
      const tw = ctx.measureText(said).width;
      // baseline-top label below the prop: colliders step DOWN (dir +1), away from the machinery
      const lh = Math.max(9, 11 / zoom) + 2 / zoom;
      const ly = placeLabel(placed, X + Wd / 2, Y + Hd + 2 / zoom, tw, lh, 1);
      voiceSay('activeFlow', { x: X, y: Y, w: Wd, h: Hd }, { x: X + Wd / 2 - tw / 2, y: ly, w: tw, h: lh }, (c) => {
        c.save();
        c.font = VAL_FONT(); c.textAlign = 'center'; c.textBaseline = 'top';
        c.globalAlpha = isFrom ? 0.95 : pulse;
        c.shadowBlur = 3; c.shadowColor = col; c.fillStyle = col;
        c.fillText(said, X + Wd / 2, ly);
        c.restore();
      });
    }
    ctx.restore();
  }

  /* ---------- THE HAND, DRAWN (2026-10-10) ----------
     A drag's ghost is drawn GEOMETRY — the dashed tiles + chevrons drawBeltPreview already draws (never convey.drawBelts: a second
     belt array per frame would drop the conveyor's atlas every frame, H9), the junction that would land as its own sprite at low
     alpha, the target outlined green or red — and ONE caption at the pointer through the arbiter (activeFlow). */
  function cursorWorld() {
    if (!cv) return { x: 0, y: 0 };
    const c = toCanvas({ clientX: lastClient.x, clientY: lastClient.y });
    return { x: (c.x - panX) / zoom, y: (c.y - panY) / zoom };
  }
  function drawJunctionGhosts(list, now, alpha) {
    if (!list || !list.length || typeof PropSprites === 'undefined') return;
    ctx.save(); ctx.globalAlpha = alpha; PropSprites.setCtx(ctx); PropSprites.setNow(now);
    try { for (const j of list) PropSprites.draw({ t: j.t, x: j.x, y: j.y, w: 1, h: 1 }, false); } finally { ctx.restore(); }
  }
  function drawHandGhost(t, now) {
    if (dropPick) {   // PICK WHAT GOES HERE waits: its belt stays drawn and a pin marks the tile
      // the piece pointed at in the dock: the belt IT gets and where it stands (probeDrop laid it on a copy) — else the route to the pin
      const hot = dropPick.hot ? dropPick.opts.find(q => q.ok && q.t === dropPick.hot) : null, path = hot && hot.path ? hot.path : dropPick.path;
      if (path.length) drawBeltPreview(t, { path }, '#7ee2a8');
      if (hot && hot.rect) { const r = hot.rect; ctx.save(); ctx.strokeStyle = 'rgba(126,226,168,.95)'; ctx.lineWidth = 1.5 / zoom; ctx.setLineDash([3 / zoom, 2 / zoom]); ctx.strokeRect(r.x1 * t, r.y1 * t, (r.x2 - r.x1 + 1) * t, (r.y2 - r.y1 + 1) * t); ctx.restore(); }
      drawJunctionGhosts(dropPick.junctions, now, 0.6);
      const px = (dropPick.tile.x + 0.5) * t, py = (dropPick.tile.y + 0.5) * t, s = t * 0.42;
      ctx.save(); ctx.fillStyle = 'rgba(255,217,74,0.95)'; ctx.strokeStyle = 'rgba(4,6,8,0.9)'; ctx.lineWidth = 1 / zoom;
      ctx.beginPath(); ctx.moveTo(px, py + s); ctx.lineTo(px - s * 0.7, py - s * 0.2); ctx.arc(px, py - s * 0.45, s * 0.72, Math.PI * 0.86, Math.PI * 0.14, false); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(4,6,8,0.9)'; ctx.beginPath(); ctx.arc(px, py - s * 0.45, s * 0.26, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      return;
    }
    if (!drag || !HAND_PLAN_MODES[drag.mode]) return;
    const plan = handPlan(drag);
    const A = drag.mode === 'handbelt' ? station.propById(drag.propId) : null;
    if (A) drawPropSelection(A, t, 'rgba(255,217,74,.95)', false);
    if (!plan) return;
    const ok = !!plan.ok, col = plan.checking ? '#ffd24a' : ok ? '#7ee2a8' : '#ff8f80';
    if (plan.kind === 'send' && A && plan.to) strokeSendArc(sendArc(t, A, plan.to), col, now, 0.95);   // the committed arc's own curve + arrowhead (build-13)
    else if (plan.path && plan.path.length) drawBeltPreview(t, { path: plan.path }, col);
    else {   // no route to draw: a straight dashed line from where it started to the pointer says where you are aiming
      const s = A ? { x: (A.x + (A.w || 1) / 2) * t, y: (A.y + (A.h || 1) / 2) * t } : { x: (drag.from.x + 0.5) * t, y: (drag.from.y + 0.5) * t }, c = cursorWorld();
      ctx.save(); ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.2 / zoom; ctx.setLineDash([3 / zoom, 3 / zoom]);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.restore();
    }
    drawJunctionGhosts(plan.junctions, now, ok ? 0.65 : 0.35);
    if (plan.to) drawPropSelection(plan.to, t, ok ? 'rgba(126,226,168,.95)' : 'rgba(255,143,128,.95)', false);
    // the ONE voice at the pointer: what letting go here does, or why it can't (activeFlow)
    const c = cursorWorld(), box = captionBox(plan.why, c.x, null, c.y + 20 / zoom);
    box.x = c.x + 16 / zoom; captionFit(box);
    voiceSay('activeFlow', box, box, cc => captionPlate(cc, plan.why, box, col));
  }
  /* ---------- ALT VIEW (H5) ----------
     Held Alt (or the ALT VIEW key): every junction's setting under its tile (ASCII only — VT323 has no ×, so x3 / 2>1), every SEND TO
     hand-off as an arc, every line's stage count on its INBOX (n/max). At rest the junction tags stay hover-only (one-voice law);
     an INBOX whose line runs more stages than its budget allows wears its amber n/max plate — the one resting number. Read off the
     compiled plan (valPlan — the same artifact the sidecar routes by); a count the plan does not carry is never invented. */
  function altJunctionText(p, o) {
    const k = p.x + ',' + p.y, jp = probePlanOnceCrewed() || valPlan, cfg = jp && jp.junctions && jp.junctions[k];
    const I = (typeof Pipeline !== 'undefined' && Pipeline._internals) || null, map = valPlan && valPlan.belts;
    const outs = I && map ? I.outLanes(map, p.x, p.y).length : 0, ins = I && map ? I.inLanes(map, p.x, p.y).length : 0;
    if (p.t === 'splitter') return (cfg && cfg.divide ? 'PARTS x' : fanoutOnceCrewed()[k] ? 'COPY x' : 'TURNS x') + outs;
    if (p.t === 'merger') return ins + '>1';
    if (p.t === 'joiner') return 'WAITS ' + ((cfg && cfg.expect) || ins) + '/' + ((cfg && cfg.expect) || ins);
    if (p.t === 'loop') return 'UP TO x' + ((cfg && cfg.max) || (typeof Pipeline !== 'undefined' && Pipeline.LOOP_MAX_DEFAULT) || 5);
    if (p.t === 'filter') {
      const r = (cfg && cfg.routes) || {}, tags = Object.keys(r).map(s => String(s).slice(0, 4).toUpperCase());
      return (tags.length ? tags.join('/') + (cfg && cfg.def ? '/ELSE' : '') : (cfg && cfg.def ? 'ELSE' : 'SORTS'));
    }
    return null;
  }
  /* a line's stage count n and ceiling max, from the plan — rec.stages when the compiler records it, else a LINE_TOO_LONG finding,
     else (only when asked for the full count — Alt held) the compiler's own walk. ONCE per compiled plan (repair 2026-10-11, H9):
     this runs every frame in the Conveyors tab, and the walk is a DFS over the line's belts — memoized per valPlan + line, and at
     rest (no Alt) never walked at all: only an over-budget line shows then, and an over-budget line always carries its finding. */
  let stagesPlan = null, stagesMemo = null;
  function lineStagesOf(rec, rest) {
    // a line with no INBOX (a BAY belted to an OUTBOX before its INBOX went down, a ship-out fragment) has no plate to carry a count —
    // and the compiler counts none for it: Alt read .worst off that null every frame, and every later line lost its plate (wave 2)
    if (!rec || !valPlan || !rec.intakes || !rec.intakes.length) return null;
    if (stagesPlan !== valPlan) { stagesPlan = valPlan; stagesMemo = new Map(); }
    const mk = rec.lineId + (rest ? '|rest' : '|full');
    if (stagesMemo.has(mk)) return stagesMemo.get(mk);
    const max = ((rec.limits && rec.limits.maxHops != null) ? rec.limits.maxHops : ((typeof Pipeline !== 'undefined' && Pipeline.LINE_LIMIT_DEFAULTS && Pipeline.LINE_LIMIT_DEFAULTS.maxHops) || 6)) + 1;
    let v = null;
    if (typeof rec.stages === 'number') v = { n: rec.stages, max, over: rec.stages > max };
    else {
      const e = (valPlan.errors || []).find(q => q.code === 'LINE_TOO_LONG' && q.lineId === rec.lineId);
      if (e) v = { n: e.stages, max: e.maxHops + 1, over: true };
      else if (!rest) {
        const ls = (typeof Pipeline !== 'undefined' && Pipeline.lineStages) ? Pipeline.lineStages(valPlan, rec.lineId) : null;   // the compiler's own count
        v = ls && ls.stages > 0 ? { n: ls.stages, max: ls.max, over: ls.stages > ls.max } : null;
      }
    }
    if (v && !rest && typeof Pipeline !== 'undefined' && Pipeline.lineStages) { const ls = Pipeline.lineStages(valPlan, rec.lineId); if (ls) v.worst = ls.worst; }   // (null where the compiler cannot count: never read through it)
    stagesMemo.set(mk, v);
    return v;
  }
  const LINE_HUES = ['#c58be0','#e07a8b','#9fb5e0','#d7a6cf','#9f9cde'];
  let hueVer=-1,hueMemo=[];
  function lineOutlines() {
    if(hueVer===geoVer)return hueMemo;
    hueVer=geoVer;hueMemo=[];
    for(const c of valComps||[]) { const id=c.intakes&&c.intakes[0]; if(!id||!station.lineMembers)continue; const m=station.lineMembers(id);if(!m)continue;
      let hash=0;for(const ch of String(id))hash=(Math.imul(hash,31)+ch.charCodeAt(0))>>>0;
      const mine=new Set(m.links);hueMemo.push({hue:LINE_HUES[hash%LINE_HUES.length],ids:m.ids,cells:linksMemoed().filter(l=>mine.has(l.id)).flatMap(l=>l.path||[])});
    } return hueMemo;
  }
  function drawAltView(t) {
    if (!cacheGeo || !valPlan || buildGroup !== 'workflow' && !altOn()) return;
    if (t * zoom < 7) return;   // a tile this small cannot carry a word
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, fh = Math.max(6, 8 / zoom), alt = altOn();
    const plate = (text, cx, y, col, layer, anchor) => {
      ctx.save(); ctx.font = TAG_FONT(); const tw = ctx.measureText(text).width; ctx.restore();
      const box = { x: cx - tw / 2 - 2 / zoom, y: y - 1 / zoom, w: tw + 4 / zoom, h: fh + 2 / zoom };
      const paint = c => {
        c.save(); c.font = TAG_FONT(); c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillStyle = 'rgba(3,2,1,.8)'; c.fillRect(box.x, box.y, box.w, box.h);
        c.strokeStyle = col; c.globalAlpha = 0.7; c.lineWidth = 1 / zoom; c.strokeRect(box.x, box.y, box.w, box.h); c.globalAlpha = 1;
        c.fillStyle = col; c.fillText(text, cx, y); c.restore();
      };
      if (layer) voiceSay(layer, anchor || box, box, paint); else paint(ctx);
    };
    if(alt) { ctx.save();ctx.globalAlpha=0.55;for(const line of lineOutlines()){for(const id of line.ids){const p=station.propById(id);if(p)drawPropSelection(p,t,line.hue,false);}drawBeltCells(t,line.cells,line.hue);}ctx.restore(); }
    if (alt) for (const p of (cacheGeo.props || [])) {   // every junction's setting, under its tile — part of the machine (not a voice)
      if (!JUNCTION_TAG_TYPES[p.t]) continue;
      const text = altJunctionText(p, o); if (!text) continue;
      plate(text, (p.x + o.tx + 0.5) * t, (p.y + o.ty + 1) * t + 2 / zoom, '#86dcff');
    }
    for (const rec of (valPlan.lines || [])) {   // a line's stages on its INBOX: always under Alt, at rest only when over budget
      const st = lineStagesOf(rec, !alt); if (!st || (!alt && !st.over)) continue;
      const iid = rec.intakes && rec.intakes[0], ip = iid && (cacheGeo.props || []).find(q => q.id === iid); if (!ip) continue;
      const X = (ip.x + o.tx) * t, Y = (ip.y + o.ty) * t, W = (ip.w || 1) * t;
      plate(st.n + '/' + st.max + ' STAGES' + (alt && st.worst > st.n ? ' · UP TO ' + st.worst + ' WITH LOOPS' : ''), X + W / 2, Y - fh - 4 / zoom, st.over ? '#ffbe3c' : '#7ee2a8', alt ? null : 'topNag', { x: X, y: Y, w: W, h: (ip.h || 1) * t });
    }
    /* every SEND TO under Alt: NOT drawn here. drawSendLinks already strokes each pointer in the colour the COMPILED plan gives it
       (the plan's SEND TO table — green live, red OFF) and, with Alt held, says its words on every arc (SENDS TO X / SEND TO X IS OFF).
       A second arc read off the doc pointer painted green for a SEND TO the compiler had dropped (fix wave 10-11, #5/#21). */
  }

  // hovering an agent-bound endpoint (a PC = compute, a BAY = routing) floats the bound agent's name above it —
  // so a SHARED room (several agents, several PCs) stays legible without one-room-per-agent. An unbound PC reads
  // amber "unassigned" to invite binding. (Belts/conveyors gain the same tag in Phase 2b once they carry agentId.)
  function drawAgentTag(t) {
    if (drag || !hoverPropId) return;
    const p = station.propById(hoverPropId);
    if (!p) return;
    const anchor = { x: p.x * t, y: p.y * t, w: (p.w || 1) * t, h: (p.h || 1) * t };
    /* ONE-VOICE LAW: while the DOM prop card (the Fallout-style hover panel) is up for THIS prop,
       it IS the hover voice — the canvas tag would be a second caption on the same machine. Still
       CLAIM the hover slot (an empty draw) so lower layers (nags, placards, ghost) mute near the
       machine the user is actually looking at. The chain line the tag used to add is folded into
       the card itself (propCardHTML) so no information is lost. */
    const cardUp = propCard && propCard.style.display === 'block' && propCardKey && propCardKey.indexOf('p:' + p.id + ':') === 0;
    if (cardUp) { voiceSay('hover', anchor, anchor, null); return; }
    const isPc = isPcProp(p.t), isBay = p.t === 'bay', isIntake = p.t === 'intake';
    if (!isPc && !isBay && !isIntake) return;
    // a NAMED line's INBOX glances its line name (line naming — registered through the arbiter like every
    // other hover voice; an unnamed intake keeps its pre-existing silence, no new resting text).
    if (isIntake && !p.label) return;
    const bound = isIntake ? true : !!p.agentId;
    // a role-carrying dock's glance names the role it wants while unbound ("BAY · needs a RESEARCHER")
    const ri = (!bound && p.role && typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(p.role) : null;
    const txt = isIntake ? lineWordOf(p)
      : (isPc ? 'PC · ' : (p.label || 'BAY') + ' · ') + (bound ? String(p.agentId).replace(/^tg_/, '') : (ri ? 'needs a ' + p.role + ' — ' + ri.desc : 'unassigned'));
    // dock→dock affordance: a BOUND bay's glance also says where its OUTPUT goes — read from the compiled
    // plan's chain record (valPlan.chains — the same fact the sidecar routes by), so the tag can never
    // claim a handoff dispatch wouldn't perform. Same tag chrome, stacked one line above; still a glance,
    // never a window. A beltless dock has no chain record and gains no line.
    let t2 = null, ch = null;
    if (isBay && bound && valPlan && valPlan.chains) {
      // PER BAY (multi-bay): the writer's first bay hands off to the editor, its second ships out
      const dRec = valPlan.dockChains && valPlan.dockChains[p.id];
      ch = dRec || valPlan.chains[p.agentId];
      const nx = dRec ? (dRec.next || []).map(d => (valPlan.agentOfDock && valPlan.agentOfDock[d]) || d) : ((ch && ch.next) || []);
      t2 = !ch ? null
        : (nx.length) ? '▸ HANDS OFF TO ' + nx.map(agentLabelFor).join(' + ')
        : ch.outbox ? '▸ SHIPS TO OUTBOX'
        : ch.deadEnd ? '▸ OUTPUT DEAD-ENDS' : null;
    }
    ctx.save();
    ctx.font = (8 / zoom) + "px 'VT323','Courier New',monospace";
    const pad = 5 / zoom, bh = 11 / zoom;
    const bw = ctx.measureText(txt).width + pad * 2;
    const bw2 = t2 ? ctx.measureText(t2).width + pad * 2 : 0;
    ctx.restore();
    const cx = (p.x + (p.w || 1) / 2) * t, topY = p.y * t - 2 / zoom;
    const lines = t2 ? 2 : 1, wMax = Math.max(bw, bw2);
    voiceSay('hover', anchor, { x: cx - wMax / 2, y: topY - bh * lines, w: wMax, h: bh * lines }, (c) => {
      c.save();
      c.font = (8 / zoom) + "px 'VT323','Courier New',monospace"; c.textAlign = 'center'; c.textBaseline = 'bottom';
      c.fillStyle = 'rgba(8,16,12,0.92)'; c.fillRect(cx - bw / 2, topY - bh, bw, bh);
      c.fillStyle = bound ? 'rgba(125,240,200,0.96)' : 'rgba(255,190,60,0.96)';
      c.fillText(txt, cx, topY - 2 / zoom);
      if (t2) {
        const top2 = topY - bh;
        c.fillStyle = 'rgba(8,16,12,0.92)'; c.fillRect(cx - bw2 / 2, top2 - bh, bw2, bh);
        // handoff/ship-out = the bound green; a dead-ending output reads amber (same invite-to-fix tone as 'unassigned')
        c.fillStyle = (ch.next && ch.next.length) || ch.outbox ? 'rgba(125,240,200,0.96)' : 'rgba(255,190,60,0.96)';
        c.fillText(t2, cx, top2 - 2 / zoom);
      }
      c.restore();
    });
  }

  function propSelectionRect(p,t) {
    const mount=station.mountOf?station.mountOf(p):null;
    return (PropSprites.selectionBounds&&PropSprites.selectionBounds(mount?{...p,mount}:p))
      || {x:p.x*t,y:p.y*t,width:p.w*t,height:p.h*t};
  }
  function drawPropSelection(p,t,color,footprint=true) {
    const b=propSelectionRect(p,t),pad=1/zoom;
    ctx.save();ctx.strokeStyle=color;
    if(footprint){
      ctx.globalAlpha=.22;ctx.lineWidth=1/zoom;ctx.setLineDash([2/zoom,3/zoom]);
      ctx.strokeRect(p.x*t,p.y*t,p.w*t,p.h*t);ctx.setLineDash([]);ctx.globalAlpha=1;
    }
    ctx.lineWidth=1.5/zoom;ctx.strokeRect(b.x-pad,b.y-pad,b.width+pad*2,b.height+pad*2);ctx.restore();
  }
  function drawHover(t) {
    const selected=selectedPropId&&station.propById(selectedPropId);
    if(selected){
      drawPropSelection(selected,t,'rgba(244,200,112,.9)');
    }
    for(const id of groupIds){const gp=station.propById(id);if(gp)drawPropSelection(gp,t,'rgba(244,200,112,.9)',false);}
    if(selBelts){const bs=beltSel();if(bs)drawBeltCells(t,bs.cells,'rgba(244,200,112,.85)');}   // the belts the selection took (THE HAND part 2)
    if(beltCardHot&&beltCardHot.ver===geoVer)drawBeltCells(t,beltCardHot.cells,'rgba(255,143,128,.9)');   // the belt card's REMOVE key under the pointer: the belt it takes (build-17)
    if (selectedRoomId && !(drag && (drag.mode === 'roomresize' || drag.mode === 'move'))) drawRoomSelection(t);   // (a resize or a move draws its own ghost)
    if (drag) return;
    // a hovered prop (select/reclaim) outlines on top of any room outline
    if ((tool === 'select' || tool === 'reclaim' || (tool === 'dupe' && !dupe)) && hoverPropId) {
      const p = station.propById(hoverPropId);
      if (p) {
        drawPropSelection(p,t,tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)');
        return;
      }
    }
    // a belt is reclaimable/inspectable even though it sits ON a deck: highlight the BELT tile (not
    // the room under it) so the outline matches what a click actually targets (belt-before-room).
    if ((tool === 'reclaim' || tool === 'select') && hoverTile && station.beltAt(hoverTile.tx, hoverTile.ty)) {
      ctx.lineWidth = 1.5 / zoom;
      ctx.strokeStyle = tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)';
      ctx.strokeRect(hoverTile.tx * t + 1, hoverTile.ty * t + 1, t - 2, t - 2);
      return;
    }
    if (tool !== 'reclaim' && tool !== 'paint' && !(tool === 'dupe' && !dupe)) return;
    if (!hoverRoomId) return;
    const rm = station.roomById(hoverRoomId); if (!rm) return;
    const protectedSpawn = tool === 'reclaim' && hoverRoomId === station.spawnRoomId();
    ctx.lineWidth = 1.5 / zoom;
    ctx.strokeStyle = protectedSpawn ? 'rgba(255,200,80,0.95)' : (tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)');
    for (const r of rm.rects) ctx.strokeRect(r.x1 * t + 1, r.y1 * t + 1, (r.x2 - r.x1 + 1) * t - 2, (r.y2 - r.y1 + 1) * t - 2);
    if (protectedSpawn) {
      /* THE SPAWN-ROOM LOCK BADGE. Two laws were broken by one line here:
         • '⌂' (U+2302) is NOT in VT323 — the browser silently fell back to another face for that one
           glyph, so the badge rendered at foreign metrics (symbol-glyph law);
         • it was painted with a bare ctx.fillText, OUTSIDE the one-voice arbiter, so it could print on
           top of a hover nameplate or a validation callout claiming the same tile.
         Now it is a DRAWN padlock — no font, no fallback, nothing to mis-measure — registered on the
         `hover` layer (it is a fact about the room under the pointer) so the arbiter mutes it exactly
         like every other voice when something louder is speaking at that anchor. */
      const z = rm.rects[0];
      const box = { x: z.x1 * t, y: z.y1 * t, w: t, h: t };
      voiceSay('hover', box, box, (c) => {
        const cx = (z.x1 + 0.5) * t, cy = (z.y1 + 0.5) * t, s = Math.max(3, 7 / zoom);
        c.save();
        c.strokeStyle = c.fillStyle = 'rgba(255,200,80,0.95)';
        c.lineWidth = Math.max(0.6, 1.2 / zoom);
        c.fillRect(cx - s / 2, cy - s * 0.1, s, s * 0.6);                       // the body
        c.beginPath();                                                          // the shackle
        c.arc(cx, cy - s * 0.1, s * 0.28, Math.PI, 0);
        c.stroke();
        c.restore();
      });
    }
  }

  /* ---------- THE GESTURE BADGE (2026-08-07 build-mode overhaul) ----------
     What you are about to do, printed ON the thing you are about to do it to. The dimensions used
     to live in the DOM action tip trailing the cursor into a screen corner — you dragged a room in
     the middle of the floor and read its size at the bottom-right of the glass. Now it is a small
     phosphor plate pinned to the ghost's own top edge, green when the model says the placement is
     legal and red with the REASON on a second line when it isn't.
     It registers as `activeFlow` (top priority) so the one-voice arbiter mutes every lower label
     near it — the ghost speaks alone while a gesture is live. */
  function ghostBadge(t, lines, ok, rect, warn) {
    const fs = Math.max(9, 11 / zoom), lh = fs * 1.08, pad = fs * 0.34;
    ctx.font = fs + "px 'VT323','Courier New',monospace";
    let wMax = 0;
    for (const s of lines) wMax = Math.max(wMax, ctx.measureText(s).width);
    const bw = wMax + pad * 2, bh = lh * lines.length + pad * 1.6;
    /* CLAMP TO THE VISIBLE GLASS — the canvas runs UNDER the build dock and the top bar, so
       clamping to the canvas edge is not clamping to anything the user can read. A ghost near the
       left of the floor put its badge behind the dock and you lost the first words of the readout
       ("…SEARCH LINE — CLICK TO STAMP"). viewInsets is the same measurement fitCamera frames by. */
    const ins = viewInsetsFrame();
    const topWorld = (ins.t - panY) / zoom;
    // above the ghost by default; flip below when that would land off the top of the glass
    const above = rect.y1 * t - bh - fs * 0.35;
    const by = above > topWorld + fs ? above : (rect.y2 + 1) * t + fs * 0.35;
    const leftWorld = (ins.l - panX) / zoom, rightWorld = (cv.width - panX) / zoom, m = 4 / zoom;
    let bx = (rect.x1 + rect.x2 + 1) / 2 * t - bw / 2;
    bx = clamp(bx, leftWorld + m, Math.max(leftWorld + m, rightWorld - bw - m));
    const cx = bx + bw / 2;
    const box = { x: bx, y: by, w: bw, h: bh };
    voiceSay('activeFlow', box, box, () => {
      ctx.fillStyle = 'rgba(4,6,8,0.86)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = warn ? 'rgba(255,200,90,0.9)' : ok ? 'rgba(120,255,170,0.9)' : 'rgba(255,120,110,0.9)';
      ctx.strokeRect(bx + 0.5 / zoom, by + 0.5 / zoom, bw - 1 / zoom, bh - 1 / zoom);
      ctx.font = fs + "px 'VT323','Courier New',monospace";
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillStyle = i === 0
          ? (ok ? 'rgba(180,255,215,1)' : 'rgba(255,190,180,1)')
          : (warn ? 'rgba(255,205,110,1)' : ok ? 'rgba(150,220,190,.85)' : 'rgba(255,150,140,.95)');
        ctx.fillText(lines[i], cx, by + pad * 0.8 + i * lh);
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    });
  }

  /* Corner brackets + per-tile edge ticks on the ghost. The brackets read as a targeting reticle
     instead of a flat highlighted rectangle, and the ticks let you COUNT the footprint against the
     grid without moving your eyes off it (the badge gives the number; the ticks prove it). */
  function ghostReticle(t, rect, line) {
    const X = rect.x1 * t, Y = rect.y1 * t, Wd = (rect.x2 - rect.x1 + 1) * t, Hd = (rect.y2 - rect.y1 + 1) * t;
    const arm = Math.min(Wd, Hd) * 0.3, cap = Math.min(arm, t * 2.2);
    // 3 SCREEN px, not 3 world px — a reticle that thins out as you zoom out stops reading as one
    ctx.strokeStyle = line; ctx.lineWidth = 3 / zoom;
    ctx.beginPath();
    ctx.moveTo(X, Y + cap); ctx.lineTo(X, Y); ctx.lineTo(X + cap, Y);
    ctx.moveTo(X + Wd - cap, Y); ctx.lineTo(X + Wd, Y); ctx.lineTo(X + Wd, Y + cap);
    ctx.moveTo(X + Wd, Y + Hd - cap); ctx.lineTo(X + Wd, Y + Hd); ctx.lineTo(X + Wd - cap, Y + Hd);
    ctx.moveTo(X + cap, Y + Hd); ctx.lineTo(X, Y + Hd); ctx.lineTo(X, Y + Hd - cap);
    ctx.stroke();
    if (t * zoom < 7) return;   // ticks turn to mush below ~7 device px per tile
    const tick = Math.min(t * 0.3, 4 / zoom);
    ctx.lineWidth = 1 / zoom; ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let gx = rect.x1 + 1; gx <= rect.x2; gx++) { const px2 = gx * t; ctx.moveTo(px2, Y); ctx.lineTo(px2, Y + tick); ctx.moveTo(px2, Y + Hd); ctx.lineTo(px2, Y + Hd - tick); }
    for (let gy = rect.y1 + 1; gy <= rect.y2; gy++) { const py2 = gy * t; ctx.moveTo(X, py2); ctx.lineTo(X + tick, py2); ctx.moveTo(X + Wd, py2); ctx.lineTo(X + Wd - tick, py2); }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // the bounding rect of a brush stroke's cells — the badge needs something to pin itself to
  function cellsRect(cells) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const k of cells) { const p = k.split(','), x = +p[0], y = +p[1]; if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
    return x2 < x1 ? null : { x1, y1, x2, y2 };
  }

  /* ---------- THE CANDIDATE WASH: where this line CAN go ----------
     Painted from the cached field (lineField) — the frame does zero model work here, it fills the
     pre-merged runs and strokes the pre-merged boundary. Matte and dim on purpose: this is ground
     being described, not a control. It speaks the GRID's phosphor (the same rgba(120,200,255) the
     apron uses) so it reads as "buildable floor", never as a second ghost.

     It draws ABOVE the light layer with the crosshair: an instrument painted before
     StationBake.drawLight is swallowed by the deck it is supposed to be describing. */
  function drawLineField(t) {
    if (tool !== 'line') return;
    const f = lineField(lineType);
    if (!f || !f.runs.length) return;
    ctx.save();
    ctx.fillStyle = 'rgba(120,200,255,0.075)';
    for (const r of f.runs) ctx.fillRect(r.x1 * t, r.ty * t, (r.x2 - r.x1 + 1) * t, t);
    ctx.strokeStyle = 'rgba(120,200,255,0.34)';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    for (const e of f.edges) { ctx.moveTo(e[0] * t, e[1] * t); ctx.lineTo(e[2] * t, e[3] * t); }
    ctx.stroke();
    ctx.restore();
  }

  // REFIT-FOOTPRINT-BEGIN
  // Project the same edit the gesture will commit, on an isolated document. This
  // keeps sealed rooms and moved airlocks honest without touching save/undo state.
  function projectFootprint(model, doc, candidate) {
    const preview = model.deserialize(doc);
    const res = candidate.moveId
      ? preview.moveRoom(candidate.moveId, candidate.dx, candidate.dy)
      : preview.addRoom({ kind: candidate.kind, rects: candidate.rects });
    if (!res.ok) return { ok: false, msg: res.msg, runs: [], openings: [] };
    const id = candidate.moveId || res.id, room = preview.roomById(id), geo = preview.projectGeometry();
    const origin = geo.origin || { tx: 0, ty: 0 }, cells = [], seen = new Set();
    const at = (x, y) => {
      const lx = x - origin.tx, ly = y - origin.ty;
      return lx < 0 || ly < 0 || lx >= geo.COLS || ly >= geo.ROWS ? null : geo.zoneGrid[geo.idx(lx, ly)];
    };
    const edge = (x, y, side, dx, dy) => {
      const neighbor = at(x + dx, y + dy);
      if (neighbor === id) return; // adjacent rectangles form one footprint
      const key = x + ',' + y + ',' + side;
      if (seen.has(key)) return;
      seen.add(key);
      const lx = x - origin.tx, ly = y - origin.ty;
      const open = neighbor != null && geo.canStep(lx, ly, lx + dx, ly + dy);
      cells.push({ side, x: x + (side === 'e' ? 1 : 0), y: y + (side === 's' ? 1 : 0), length: 1, open, neighbor });
    };
    for (const r of room.rects) {
      for (let x = r.x1; x <= r.x2; x++) { edge(x, r.y1, 'n', 0, -1); edge(x, r.y2, 's', 0, 1); }
      for (let y = r.y1; y <= r.y2; y++) { edge(r.x1, y, 'w', -1, 0); edge(r.x2, y, 'e', 1, 0); }
    }
    const horizontal = e => e.side === 'n' || e.side === 's';
    cells.sort((a, b) => a.side.localeCompare(b.side) || (horizontal(a) ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));
    const runs = [];
    for (const e of cells) {
      const p = runs[runs.length - 1], h = horizontal(e);
      // One clear architectural opening may border several logical rooms.
      if (p && p.side === e.side && p.open === e.open && (e.open || p.neighbor === e.neighbor) &&
          (h ? p.y === e.y && p.x + p.length === e.x : p.x === e.x && p.y + p.length === e.y)) {
        p.length++;
        if (e.neighbor != null && !p.neighbors.includes(e.neighbor)) p.neighbors.push(e.neighbor);
      } else runs.push({ ...e, neighbors: e.neighbor == null ? [] : [e.neighbor] });
    }
    return { ok: true, rects: room.rects, runs, openings: runs.filter(e => e.open), sealed: runs.some(e => e.neighbor != null && !e.open) };
  }
  // REFIT-FOOTPRINT-END

  let footprintMemo = null;
  function structureGhost(g) {
    if (!g || !g.v || !g.v.ok || typeof WorldModel === 'undefined') return null;
    const move = g.move && drag && drag.mode === 'move';
    if (!move && g.kind !== 'room' && g.kind !== 'hall') return null;
    const candidate = { rects: g.rects, kind: g.kind === 'hall' ? 'corridor' : kind,
      moveId: move ? drag.roomId : null, dx: g.dx || 0, dy: g.dy || 0 };
    const key = geoVer + '|' + JSON.stringify(candidate);
    if (!footprintMemo || footprintMemo.key !== key) {
      footprintMemo = { key, plan: projectFootprint(WorldModel, station.doc(), candidate) };
    }
    return footprintMemo.plan;
  }

  function drawFootprint(t, plan, fill, line) {
    ctx.save();
    ctx.fillStyle = fill;
    for (const r of plan.rects) ctx.fillRect(r.x1 * t, r.y1 * t, (r.x2 - r.x1 + 1) * t, (r.y2 - r.y1 + 1) * t);
    ctx.strokeStyle = line; ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    for (const e of plan.runs) {
      if (e.open) continue;
      const h = e.side === 'n' || e.side === 's', x = e.x * t, y = e.y * t;
      ctx.moveTo(x, y); ctx.lineTo(x + (h ? e.length * t : 0), y + (h ? 0 : e.length * t));
    }
    ctx.stroke();
    // A pair of small jamb marks shows where the wall will open. Keep the span
    // clear: an unbroken rectangle border falsely reads as a wall across a join.
    for (const e of plan.openings) {
      const h = e.side === 'n' || e.side === 's', x = e.x * t, y = e.y * t, len = e.length * t;
      const depth = Math.min(t * .42, 7 / zoom), arm = Math.min(len * .2, 7 / zoom);
      ctx.fillStyle = 'rgba(120,255,190,.13)';
      ctx.fillRect(x - (h ? 0 : depth), y - (h ? depth : 0), h ? len : depth * 2, h ? depth * 2 : len);
      ctx.strokeStyle = 'rgba(180,255,215,.92)'; ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      if (h) {
        for (const [a, sign] of [[x, 1], [x + len, -1]]) { ctx.moveTo(a + arm * sign, y - depth); ctx.lineTo(a, y - depth); ctx.lineTo(a, y + depth); ctx.lineTo(a + arm * sign, y + depth); }
      } else {
        for (const [a, sign] of [[y, 1], [y + len, -1]]) { ctx.moveTo(x - depth, a + arm * sign); ctx.lineTo(x - depth, a); ctx.lineTo(x + depth, a); ctx.lineTo(x + depth, a + arm * sign); }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function placementReason(g) {
    if (g.kind === 'resize') return (g.v && g.v.msg) || 'Choose a clear space';   // a room's own refusal names its own reason
    if (g.v && g.v.short) return g.v.short;   // a refusal with a floor caption of its own (a belt out of an OUTBOX / into an INBOX)
    const code = g.v && g.v.error;
    if (code === 'OFF_DECK') return 'Place this on a room floor';
    if (code === 'NEEDS_WALL') return 'Place this against the back wall';
    if (code === 'NEEDS_SURFACE') return 'Place this on a table or counter';
    if (code === 'OVERLAP') {
      const ignore = drag && drag.mode === 'propmove' ? drag.propId : null;
      const hit = station.props().find(p=>p.id!==ignore && !propSpec(p.t).flat && g.rects.some(r=>p.x<=r.x2 && p.x+p.w-1>=r.x1 && p.y<=r.y2 && p.y+p.h-1>=r.y1));
      if (hit) return 'Blocked by '+(propSpec(hit.t).label || hit.t)+' · choose a clear space';
      return 'Overlaps another room · move beside its edge';
    }
    return (g.v && g.v.msg) || 'Choose a clear space';
  }
  // the selection box (SELECT, a drag across empty floor): the tiles it covers, and a cyan outline on everything it will take
  function drawSelectBox(t) {
    const r = norm(drag.start, drag.cur), ids = propsInBox(r), bb = beltsInBox(r, drag.add ? selectionIds().concat(ids) : ids);
    for (const id of ids) { const p = station.propById(id); if (p) drawPropSelection(p, t, 'rgba(120,220,255,0.95)', false); }
    drawBeltCells(t, bb.cells, 'rgba(120,220,255,0.85)');   // the belts it will take with them (THE HAND part 2)
    const X = r.x1 * t, Y = r.y1 * t, W = (r.x2 - r.x1 + 1) * t, H = (r.y2 - r.y1 + 1) * t;
    ctx.save();
    ctx.fillStyle = 'rgba(120,220,255,0.06)'; ctx.fillRect(X, Y, W, H);
    ctx.strokeStyle = 'rgba(120,220,255,0.85)'; ctx.lineWidth = 1.2 / zoom; ctx.setLineDash([4 / zoom, 3 / zoom]);
    ctx.strokeRect(X + 0.5 / zoom, Y + 0.5 / zoom, W - 1 / zoom, H - 1 / zoom);
    ctx.restore();
    const nb = bb.n, what = [ids.length ? ids.length + (ids.length === 1 ? ' THING' : ' THINGS') : '', nb ? nb + (nb === 1 ? ' BELT' : ' BELTS') : ''].filter(Boolean).join(' · ');
    ghostBadge(t, what ? [what, drag.add ? 'RELEASE TO ADD THEM' : 'RELEASE TO SELECT'] : ['DRAG ACROSS WHAT YOU WANT'], !!what, r);
  }
  // belt tiles outlined (a selection's belts in gold, the box's in cyan) — dashed, drawn geometry (never convey.drawBelts, H9)
  function drawBeltCells(t, cells, col) {
    if (!cells || !cells.length) return;
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.3 / zoom; ctx.setLineDash([3 / zoom, 2 / zoom]);
    for (const q of cells) ctx.strokeRect(q.x * t + 2 / zoom, q.y * t + 2 / zoom, t - 4 / zoom, t - 4 / zoom);
    ctx.restore();
  }
  /* THE PASTE GHOST (THE HAND part 2): the clip's machines in their own art where they would land, each footprint green where it
     fits and red where it does not, every belt tile dashed with a chevron the way it flows (green / red per tile — drawn
     geometry, never convey.drawBelts: a second belt array per frame drops the atlas, H9), and on the badge what is held and
     why not. All of it read off the memoized clipGhost — nothing here asks the model. */
  function drawClipGhost(t, now, g) {
    if (!dupe || !dupe.clip) return;
    const c = dupe.clip, ok = !!(g.v && g.v.ok), whole = !ok && !!g.v.whole;
    const GOOD = 'rgba(120,255,170,0.95)', BAD = 'rgba(255,120,110,0.95)';
    const ps = c.nodes.map((n, i) => ({ i, p: { id: '__clip' + i, t: n.t, x: g.ax + n.x, y: g.ay + n.y, w: n.w, h: n.h, r: n.r, m: n.m } }))
      .sort((a, b) => (a.p.y + a.p.h) - (b.p.y + b.p.h));
    ctx.save(); ctx.globalAlpha = 0.6; PropSprites.setCtx(ctx); PropSprites.setNow(now);
    try { for (const q of ps) PropSprites.draw(q.p, false); } finally { ctx.restore(); }
    for (const q of ps) {
      const bad = !ok && (whole || g.badNodes.has(q.i)), r = propRect(q.p);
      ctx.fillStyle = bad ? 'rgba(255,90,80,0.18)' : 'rgba(80,255,140,0.12)'; ctx.fillRect(r.x1 * t, r.y1 * t, (r.x2 - r.x1 + 1) * t, (r.y2 - r.y1 + 1) * t);
      drawPropSelection(q.p, t, bad ? BAD : GOOD, false);
    }
    const good = [], badT = [];
    for (const b of (c.belts || [])) { const x = g.ax + b.x, y = g.ay + b.y; ((!ok && (whole || g.badTiles.has(x + ',' + y))) ? badT : good).push({ x, y, d: b.d }); }
    if (good.length) drawBeltPreview(t, { path: good }, GOOD);
    if (badT.length) drawBeltPreview(t, { path: badT }, BAD);
    const bb = { x1: g.ax, y1: g.ay, x2: g.ax + c.w - 1, y2: g.ay + c.h - 1 };
    const lines = ['PASTE · ' + String(dupe.label || '').toUpperCase() + (dupe.rot ? ' · TURNED ' + dupe.rot * 90 : '')];
    if (ok) lines.push('CLICK TO PLACE · R TURNS IT');
    else {
      lines.push(String(g.v.short || g.v.msg || 'IT DOES NOT FIT HERE').toUpperCase());
      // the layout engine's own answer for this spot (clipLaidFor — asked once the pointer rests): the promise only when it fits
      const laid = layable(c) ? clipLaidFor(g.tx, g.ty) : null;
      if (laid && laid.ok) lines.push('A CLICK LAYS IT OUT TO FIT NEARBY');
      else if (laid) lines.push(String(laid.msg || 'IT CANNOT BE LAID OUT HERE EITHER').toUpperCase());
    }
    ghostBadge(t, lines, ok, bb);
  }
  // a group being dragged: every member's art at its new spot, outlined green (it fits) or red (something outside the group is in the way)
  function drawGroupGhost(t, now, g) {
    const ok = !!(g.v && g.v.ok), checking = !!(ok && g.v.checking);
    const line = checking ? 'rgba(255,200,90,0.95)' : ok ? 'rgba(120,255,170,0.95)' : 'rgba(255,120,110,0.95)', fill = checking ? 'rgba(255,190,60,0.12)' : ok ? 'rgba(80,255,140,0.12)' : 'rgba(255,90,80,0.16)';
    const ps = g.group.slice().sort((a, b) => (a.y + (a.h || 1)) - (b.y + (b.h || 1)));
    ctx.save(); ctx.globalAlpha = 0.65; PropSprites.setCtx(ctx); PropSprites.setNow(now);
    try { for (const p of ps) { const mount = station.mountOf ? station.mountOf(p) : null; PropSprites.draw(mount ? { ...p, mount } : p, false); } } finally { ctx.restore(); }
    for (const p of ps) { const r = propRect(p); ctx.fillStyle = fill; ctx.fillRect(r.x1 * t, r.y1 * t, (r.x2 - r.x1 + 1) * t, (r.y2 - r.y1 + 1) * t); drawPropSelection(p, t, line, false); }
    let bb = g.rects[0];
    for (const r of g.rects) bb = { x1: Math.min(bb.x1, r.x1), y1: Math.min(bb.y1, r.y1), x2: Math.max(bb.x2, r.x2), y2: Math.max(bb.y2, r.y2) };
    const lines = ['MOVE ' + (g.dx >= 0 ? '+' : '') + g.dx + ', ' + (g.dy >= 0 ? '+' : '') + g.dy + ' · ' + ps.length + ' THINGS'];
    if (!ok) lines.push(String((g.v && g.v.msg) || 'blocked').toUpperCase());
    else if (checking) lines.push(CHECKING_ROUTE);
    ghostBadge(t, lines, ok, bb, checking);
  }
  function drawGhost(t, now) {
    // paint brush: tint the crossed tiles with the chosen deck colour
    if (drag && drag.mode === 'paint' && drag.moved) {
      const base = station.FLOOR_STYLES[style] ? station.FLOOR_STYLES[style].base : '#888';
      ctx.globalAlpha = 0.55; ctx.fillStyle = base;
      let n = 0;
      for (const k of drag.cells) { const p = k.split(','); if (station.roomAt(+p[0], +p[1]) === drag.roomId) { ctx.fillRect(+p[0] * t, +p[1] * t, t, t); n++; } }
      ctx.globalAlpha = 1;
      const bb = cellsRect(drag.cells);
      if (bb) ghostBadge(t, [n + (n === 1 ? ' TILE' : ' TILES')], true, bb);
      return;
    }
    // reclaim drag: tint the belt tiles the drag will clear (destructive red), like the paint brush
    if (drag && drag.mode === 'reclaim' && drag.moved) {
      let n = 0;
      ctx.globalAlpha = 0.5; ctx.fillStyle = 'rgba(255,92,77,0.9)';
      for (const k of drag.cells) { const p = k.split(','); if (station.beltAt(+p[0], +p[1])) { ctx.fillRect(+p[0] * t, +p[1] * t, t, t); n++; } }
      ctx.globalAlpha = 1;
      const bb = cellsRect(drag.cells);
      if (bb) ghostBadge(t, n ? [n + (n === 1 ? ' BELT' : ' BELTS'), 'RELEASE TO CLEAR'] : ['DRAG ALONG A BELT'], n > 0, bb);
      return;
    }
    if (drag && drag.mode === 'box') { drawSelectBox(t); return; }
    const g = ghostInfo();
    if (!g) return;
    if (g.group) { drawGroupGhost(t, now, g); return; }
    if (g.clip) { drawClipGhost(t, now, g); return; }
    if (g.row) { drawRowGhost(t, now, g); return; }
    // Show the actual art at the exact candidate footprint, including its facing
    // and tabletop lift. The outline still communicates the model's occupied tiles.
    const rr=g.rects[0];
    const preview=g.preview||(g.kind==='prop'?{t:propType,x:rr.x1,y:rr.y1,w:rr.x2-rr.x1+1,h:rr.y2-rr.y1+1,r:propFacing(propType),m:propFlipOn(propType)}:null);
    if(preview){
      const mount=station.mountOf?station.mountOf(preview):null;
      ctx.save();ctx.globalAlpha=.65;PropSprites.setCtx(ctx);PropSprites.setNow(now);
      try{PropSprites.draw(mount?{...preview,mount}:preview,false);}finally{ctx.restore();}
    }
    const footprint = structureGhost(g);
    const ok = g.v && g.v.ok && (!footprint || footprint.ok);
    // AMBER = legal, but it will CONNECT to something already on the floor (or leave its belts behind) —
    // said on the ghost BEFORE the click, never discovered afterwards (2026-09-23 playtest)
    const links = ok && g.links && g.links.length ? g.links : null;
    const warn = !!(ok && (links || g.leftBehind || (g.v && g.v.checking)));
    // a HOVER PREVIEW is quieter than a live gesture — it is showing you an option, not a commitment,
    // and at full strength it read as "you are already dragging" every time the pointer crossed the floor
    // ...and an INVALID preview is quieter still: with ROOM armed, every pass of the pointer over
    // your own station would otherwise wash the whole floor red before you had asked for anything.
    // The outline and the badge carry the refusal; the fill does not need to shout it.
    const k = g.stamp ? (ok ? 0.6 : 0.3) : 1;
    const fill = warn ? 'rgba(255,190,60,' + (0.16 * k).toFixed(3) + ')' : ok ? 'rgba(80,255,140,' + (0.16 * k).toFixed(3) + ')' : 'rgba(255,90,80,' + (0.18 * k).toFixed(3) + ')';
    const line = warn ? 'rgba(255,200,90,' + (0.95 * k).toFixed(2) + ')' : ok ? 'rgba(120,255,170,' + (0.95 * k).toFixed(2) + ')' : 'rgba(255,120,110,' + (0.95 * k).toFixed(2) + ')';
    if (footprint && footprint.ok) drawFootprint(t, footprint, fill, line);
    else {
      ctx.lineWidth = 1.5 / zoom;
      for (const r of g.rects) {
        const X = r.x1 * t, Y = r.y1 * t, Wd = (r.x2 - r.x1 + 1) * t, Hd = (r.y2 - r.y1 + 1) * t;
        ctx.fillStyle = fill; ctx.fillRect(X, Y, Wd, Hd);
        if(!preview){ctx.strokeStyle = line; ctx.strokeRect(X + 0.5 / zoom, Y + 0.5 / zoom, Wd - 1 / zoom, Hd - 1 / zoom);}
      }
      if(preview)drawPropSelection(preview,t,line);
      else for (const r of g.rects) ghostReticle(t, r, line);
    }
    // belt: draw flow arrows along the run so the direction reads at a glance
    if (g.belt) {
      const V = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[g.dir];
      ctx.strokeStyle = line; ctx.lineWidth = 1.5 / zoom;
      const rr = g.rects[0];
      for (let x = rr.x1; x <= rr.x2; x++) for (let y = rr.y1; y <= rr.y2; y++) {
        const cx = (x + 0.5) * t, cy = (y + 0.5) * t, a = t * 0.22;
        ctx.beginPath();
        if (V[0]) { ctx.moveTo(cx - a * V[0], cy - a); ctx.lineTo(cx + a * V[0], cy); ctx.lineTo(cx - a * V[0], cy + a); }
        else { ctx.moveTo(cx - a, cy - a * V[1]); ctx.lineTo(cx, cy + a * V[1]); ctx.lineTo(cx + a, cy - a * V[1]); }
        ctx.stroke();
      }
    }
    // live readout, pinned to the ghost: the dimensions you are drawing, and — when the model says
    // no — the reason on its own line right under them. (Was a DOM tip trailing into a screen corner.)
    const r0 = g.rects[0], w = r0.x2 - r0.x1 + 1, h = r0.y2 - r0.y1 + 1;
    let dims = g.belt ? ('BELT ' + g.dir + ' · ' + Math.max(w, h) + ' LONG')
      : (hand && g.kind === 'prop' && g.stamp) ? propLabel(propType)   // THE HAND: what is held, not its footprint
      : g.kind === 'line' ? (String(g.label || '').toUpperCase() + (ok ? ' — CLICK TO PLACE' : g.laid ? ' — CLICK TO LAY IT OUT HERE' : ''))   // a red ghost invites the click only when the line fits laid out (2026-09-27 audit B1; phase E)
      : g.move ? ('MOVE ' + (g.dx >= 0 ? '+' : '') + g.dx + ', ' + (g.dy >= 0 ? '+' : '') + g.dy)
      : (tool === 'hall' ? (Math.max(w, h) + ' LONG × ' + Math.min(w, h) + ' WIDE') : (w + ' × ' + h));
    const lines = [dims];
    // a sized footprint also gets its area — "how much floor is this?" is the other question a drag asks
    if (!g.belt && !g.move && g.kind !== 'line' && w * h > 1) lines[0] = dims + '   ' + (w * h) + ' TILES';
    // (a line that fits laid out: the drawn shape will not go here, but the click lays the same line out round what stands here)
    if (!ok) lines.push(g.kind === 'line' && g.laid ? 'THE DRAWN SHAPE DOES NOT FIT HERE — IT WILL BE LAID OUT TO FIT' : ((footprint && footprint.msg) || placementReason(g)).toUpperCase());
    // the hover preview teaches BOTH gestures: this size on a click, any size on a drag
    else if (g.stamp) lines.push(g.insert ? (propType === 'bay' ? 'INSERT A STEP — THE LINE MAKES ROOM' : 'CLICK TO PUT IT ON THIS BELT') : g.kind === 'prop' ? (rowable(propType) ? 'CLICK TO PLACE · DRAG FOR A ROW' : 'CLICK TO PLACE') : 'CLICK TO PLACE · DRAG TO SIZE');
    /* SPACING (2026-09-27 audit B4): a dock hooks every belt in the 1-tile ring around it, so two docks with one empty tile
       between them share that tile — a belt there hooks BOTH, and the job goes nowhere. Said while the ghost is in hand,
       never refused (sandbox law): the Commander may still want them tight. */
    if (ok && g.kind === 'prop' && placingProp() && RING_DOCK_T[propType] && !linkedFloor()) {
      const near = station.props().find(p => RING_DOCK_T[p.t] && p.x - 1 <= r0.x2 + 1 && r0.x1 - 1 <= p.x + (p.w || 1) && p.y - 1 <= r0.y2 + 1 && r0.y1 - 1 <= p.y + (p.h || 1));
      if (near) lines.push('CLOSE TO THE ' + String(propLabel(near.t)).toUpperCase() + ' — LEAVE 2 TILES OR THEIR BELTS TOUCH');
    }
    if (links) lines.push('WILL CONNECT TO ' + linkNames(links));
    if (ok && g.v && g.v.checking) lines.push(CHECKING_ROUTE);   // (SETTLE: the route is judged once the pointer rests)
    if (ok && g.leftBehind) lines.push('ITS BELTS STAY HERE — RECONNECT WITH BELT');
    if (g.kind === 'prop' && canTurn(propType) && !propSpec(propType).flat) {
      const r = propFacing(propType), v = [[0,1],[-1,0],[0,-1],[1,0]][r];
      const cx = (r0.x1+w/2)*t, cy=(r0.y1+h/2)*t, len=t*.8;
      ctx.save(); ctx.strokeStyle=line; ctx.lineWidth=2/zoom;
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+v[0]*len,cy+v[1]*len);
      const ex=cx+v[0]*len, ey=cy+v[1]*len, a=t*.2;
      ctx.moveTo(ex-v[0]*a-v[1]*a,ey-v[1]*a+v[0]*a);ctx.lineTo(ex,ey);ctx.lineTo(ex-v[0]*a+v[1]*a,ey-v[1]*a-v[0]*a);ctx.stroke();ctx.restore();
      lines.push('FACING '+FACE_WORD[r].toUpperCase()+' · R TO ROTATE');
    }
    if (footprint && footprint.ok) {
      const n = footprint.openings.length;
      lines.push(n ? n + (n === 1 ? ' OPEN CONNECTION' : ' OPEN CONNECTIONS') : footprint.sealed ? 'SEALED EDGE' : 'SEPARATE SECTION');
    }
    ghostBadge(t, lines, ok, r0, warn);
    // NOTE: deliberately does NOT hideTip() — flashTip's transient confirmations ("room placed")
    // fire while a ghost is still on screen, and hiding here every frame would eat them instantly.
  }

  /* ---------- tooltip ---------- */
  function showTip(text, ok) {
    if (!tip) return;
    tip.textContent = text;
    tip.classList.toggle('ok', !!ok);
    tip.classList.toggle('bad', !ok);
    tip.style.display = 'block';
    placeOverlay(tip, lastClient.x, lastClient.y, 16, 14, false);   // on screen, clear of the Workflow panel, zoom-correct
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  let tipTimer = 0;
  function flashTip(ev, text, ok) {
    if (ev) lastClient = { x: ev.clientX, y: ev.clientY };   // ev-less callers (the auto first ride) anchor at the last pointer spot
    showTip(text, ok); clearTimeout(tipTimer);
    // a refusal is a sentence that names the fix: give it time to be read (1.3 s was gone before the second clause)
    tipTimer = setTimeout(hideTip, Math.min(6500, Math.max(1300, String(text || '').length * (ok ? 30 : 48))));
  }

  /* ---------- Fallout-style prop description card ----------
     A persistent hover panel (NOT the transient action tip): says what a prop IS and DOES, its footprint, and —
     for a placed functional prop — its live assignment (hosted-by agent / bound server). Shown on palette-tile
     hover (browsing) and on canvas hover of a placed functional prop. `c` = a CATALOG spec; `placed` = the live prop. */
  function propCardHTML(c, placed) {
    const fn = c.tier === 'functional';
    const tier = fn ? '<span class="pc-tier fn">⚙ SYSTEMS</span>' : '<span class="pc-tier">✦ DECOR</span>';
    // MOUNT is a placement RULE, so it belongs on the footprint line next to the other placement facts —
    // a player who only meets it as a red ghost has been told "no" without being told "why".
    const mount = c.mount === 'surface' ? ' · stands on a table'
      : c.stack ? ' · deck or table'
      : (c.surface ? ' · things can stand on it' : '');
    const foot = c.w + '×' + c.h + (c.blocks === false ? ' · walkable' : ' · solid') + mount;
    const desc = c.desc || (fn ? '' : 'Decor — looks only. Sets the mood; no effect on how the station runs.');
    let assign = '';
    if (placed && WORKSTATION_TYPES[placed.t]) {
      assign = placed.agentId
        ? '<div class="pc-assign ok">▸ HOSTED BY ' + esc(agentLabel(placed.agentId)) + '</div>'
        : '<div class="pc-assign">UNASSIGNED — click to choose an agent</div>';
    } else if (placed && placed.t === 'bay') {
      if (placed.agentId) {
        assign = '<div class="pc-assign ok">▸ AGENT ' + esc(agentLabel(placed.agentId)) + '</div>';
        // the dock→dock line the canvas tag used to carry — the card is the ONE hover voice now
        // (one-voice law), so the chain fact rides here, from the same compiled valPlan.chains.
        const dRec = valPlan && valPlan.dockChains && valPlan.dockChains[placed.id];   // PER BAY (multi-bay)
        const ch = dRec || (valPlan && valPlan.chains && valPlan.chains[placed.agentId]);
        const nx = dRec ? (dRec.next || []).map(d => (valPlan.agentOfDock && valPlan.agentOfDock[d]) || d) : ((ch && ch.next) || []);
        const t2 = !ch ? null
          : (nx.length) ? '▸ HANDS OFF TO ' + nx.map(agentLabelFor).join(' + ')
          : ch.outbox ? '▸ SHIPS TO OUTBOX'
          : ch.deadEnd ? '▸ OUTPUT DEAD-ENDS' : null;
        if (t2) assign += '<div class="pc-assign' + ((ch.next && ch.next.length) || ch.outbox ? ' ok' : '') + '">' + esc(t2) + '</div>';
      } else {
        // an unbound ROLE dock introduces itself here on hover (its floor placard is muted while hovered)
        const ri = (placed.role && typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(placed.role) : null;
        assign = ri ? '<div class="pc-assign">NEEDS A ' + esc(placed.role) + ' — ' + esc(ri.desc) + ' — click to crew</div>'
          : '<div class="pc-assign">NO AGENT — click to assign</div>';
      }
    } else if (placed && placed.t === 'plugin_terminal') {
      assign = placed.pluginId
        ? '<div class="pc-assign ok">▸ PLUGIN ' + esc(placed.pluginId) + '</div>'
        : '<div class="pc-assign">UNBOUND — click to choose a plugin</div>';
    } else if (placed && placed.t === 'connector_portal') {
      assign = placed.connectorId
        ? '<div class="pc-assign ok">▸ BOUND ' + esc(placed.connectorId) + '</div>'
        : '<div class="pc-assign">UNBOUND — click to bind a server</div>';
    } else if (placed && placed.t === 'intake' && placed.label) {
      // a NAMED line's INBOX hover names the line (line naming) — the card is the ONE hover voice in
      // BUILD MODE (one-voice law), so the fact rides here; the canvas glance covers the card-less contexts.
      assign = '<div class="pc-assign ok">▸ LINE · ' + esc(placed.label) + '</div>';
    } else if (placed && isSignProp(placed.t)) {
      // a SIGN's words are the whole fact about it — the card shows them (or that there are none)
      const words = String(placed.text || '').replace(/\s+/g, ' ').trim();
      assign = '<div class="pc-assign' + (words ? ' ok' : '') + '">' + (words ? '▸ ' + esc(words.length > 72 ? words.slice(0, 72) + '…' : words) : 'NO WORDS YET — click it to write on it') + '</div>';
    }
    // a briefed dock's hover shows its duty line (a glance answer to "what does this step DO?")
    if (placed && placed.t === 'bay' && placed.brief) {
      const bp = String(placed.brief).replace(/\s+/g, ' ');
      assign += '<div class="pc-assign">✎ ' + esc(bp.length > 72 ? bp.slice(0, 72) + '…' : bp) + '</div>';
    }
    assign += placedFindingsHTML(placed);
    return '<h4>' + esc(c.label) + '</h4>' + tier + (desc ? ('<p>' + esc(desc) + '</p>') : '') + '<div class="pc-foot">' + foot + '</div>' + assign;
  }
  /* the FULL SENTENCE for every routing finding anchored on this machine (VAL_WHY — the floor shows the short
     label), plus a brushed hookup in words: a belt from another lane touching this machine puts both on ONE line.
     Read from the same compiled plan (valPlan) and the same brushedHookups() the floor arrows draw. */
  function placedFindingsHTML(placed) {
    if (!placed || !CONNECT_TYPES[placed.t]) return '';
    let out = '';
    if (JUNCTION_TAG_TYPES[placed.t] && valPlan && cacheGeo) {
      const o = cacheGeo.origin || { tx: 0, ty: 0 }, cfg = valPlan.junctions && valPlan.junctions[(placed.x - o.tx) + ',' + (placed.y - o.ty)];
      const mode = placed.t === 'splitter' ? (cfg ? (fanoutOnceCrewed()[(placed.x - o.tx) + ',' + (placed.y - o.ty)] ? 'Every branch gets a copy: a JOINER follows the branches.' : 'Jobs take turns between the branches (no JOINER after them).') : null)
        : placed.t === 'joiner' ? (cfg && cfg.expect > 1 ? 'Waits for ' + cfg.expect + ' branches, then sends one combined result on.' : null)
        : placed.t === 'loop' ? (cfg ? 'Sends work back up to ' + (cfg.max || 5) + ' times' + (cfg.when ? ', until the verdict is ' + String(cfg.when).toUpperCase() : '') + '.' : null) : null;
      if (mode) out += '<div class="pc-assign ok">▸ ' + esc(mode) + '</div>';
    }
    const seen = {};
    for (const e of ((valPlan && valPlan.errors) || [])) {
      if (e.propId !== placed.id || seen[e.code] || !VAL_WHY[e.code]) continue;
      seen[e.code] = true;
      out += '<div class="pc-assign">⚠ ' + esc(findingWhy(e)) + '</div>';
    }
    if (brushedHookups().some(h => h.propId === placed.id))
      out += '<div class="pc-assign">⚠ A belt from another lane brushes this ' + esc(propLabel(placed.t)) + ' — the floor reads them as ONE line, so it hooks here. Leave a 1-tile gap to keep them apart.</div>';
    return out;
  }
  let propCardKey = null;
  function showPropCard(c, placed, cx, cy) {
    if (!propCard || !c) return;
    const key = placed
      ? ('p:' + placed.id + ':' + (placed.agentId || placed.connectorId || '') + ':' + (placed.label || '') + ':' + (placed.brief ? placed.brief.length : 0) + ':' + geoVer)
      : ('c:' + c.id);
    if (key !== propCardKey) { propCard.innerHTML = propCardHTML(c, placed); propCardKey = key; }
    propCard.style.display = 'block';
    placeOverlay(propCard, cx == null ? lastClient.x : cx, cy == null ? lastClient.y : cy, 16, 14, true);   // prefer above-right of the cursor
  }
  /* position a floating BUILD MODE overlay (the prop card, the action tip) beside the pointer — kept on screen and clear of the docked
     Workflow panel (2026-09-27 audit P6: the OUTBOX/LOOP cards and the joiner refusal ran off the right edge, and the insert-step
     error hid behind the panel). Reads are VISUAL px (clientX, getBoundingClientRect, innerWidth); style px live in the element's
     zoomed space, so the result is divided by the zoom actually applied above it — once (the uiZoom law, U.elZoom). A card that
     would overflow on the right flips to the LEFT of the pointer instead of being shoved under it. */
  function placeOverlay(el, ax, ay, dx, dy, above) {
    if (!el) return;
    const z = (typeof U !== 'undefined' && U.elZoom) ? (U.elZoom(el.parentElement || el) || 1) : 1;
    const r = el.getBoundingClientRect(), w = r.width || 230, h = r.height || 40;
    let right = window.innerWidth;
    const dock = root && root.querySelector('.wf-panel');
    if (dock && dock.offsetParent !== null) { const dr = dock.getBoundingClientRect(); if (dr.width > 0 && ax < dr.left) right = Math.min(right, dr.left); }
    let x = ax + dx;
    if (x + w > right - 8) x = ax - dx - w;               // flip to the left of the pointer
    x = Math.max(6, Math.min(x, right - w - 8));
    let y = above ? ay - h - dy : ay + dy;
    if (y < 6) y = ay + 20;                                  // flip below when it would clip the top
    y = Math.max(6, Math.min(y, window.innerHeight - h - 8));
    el.style.left = (x / z) + 'px';
    el.style.top = (y / z) + 'px';
  }
  function hidePropCard() { if (propCard) { propCard.style.display = 'none'; propCardKey = null; } }

  function sfx(n) { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); }

  // DEV-ONLY test hook (gated on window.__STARNET_DEV__) — lets the audit harness prove the
  // object=capability moat (place a dish → web cap appears) by placing through the REAL
  // station.addProp path at a validated tile, instead of simulating fragile canvas-drag pixel
  // coordinates. Never attached in a shipped build (the dev flag is never set there).
  function findPlaceableTile(type, w, h) {
    if (!station || !station.bounds || !station.canPlaceProp) return null;
    const b = station.bounds();
    for (let ty = b.minTy; ty <= b.maxTy; ty++)
      for (let tx = b.minTx; tx <= b.maxTx; tx++)
        if ((station.canPlaceProp(type, tx, ty, w, h) || {}).ok) return { tx, ty };
    return null;
  }
  const __test__ = {
    isOpen: () => running,
    pointer: (phase, tile, data) => { const ev=Object.assign(__test__._tileEvent(tile),data||{}); ({down:onDown,move:onMove,up:onUp,cancel:onCancel})[phase](ev); return {zoom,panX,panY,drag:drag&&drag.mode,points:touchPts.size,locked:pinchLock}; },
    /* THE HAND (2026-10-10): what is held, the picker, the floats — and REAL gestures driven through onDown/onMove/onUp (the same
       three handlers a mouse does), so a CDP/preview proof exercises the ghost AND the commit, never a shortcut into the model */
    hand: () => ({ hand: hand && Object.assign({}, hand), touchArm, flip: flipPref, alt: altOn(), pick: dropPick && { tile: dropPick.tile, opts: dropPick.opts.slice() }, floats: floaters.map(f => f.text), drag: drag && drag.mode, plan: drag && HAND_PLAN_MODES[drag.mode] ? handPlan(drag) : null }),
    setHand: h => { setHand(h || null); return hand && Object.assign({}, hand); },
    // press at tiles[0], move through the rest; `release:false` leaves the drag live (the ghost + caption can be drawn/read mid-gesture)
    gesture: (tiles, o) => {
      if (!running || !cv || !tiles || !tiles.length) return { ok: false, reason: 'not-in-build' };
      const ev = (tile, extra) => Object.assign(__test__._tileEvent(tile), { shiftKey: !!(o && o.shift), ctrlKey: !!(o && o.ctrl) }, extra || {});
      onDown(ev(tiles[0])); for (let i = 1; i < tiles.length; i++) { const e = ev(tiles[i]); lastClient = { x: e.clientX, y: e.clientY }; onMove(e); }
      const mid = { drag: drag && drag.mode, plan: drag && HAND_PLAN_MODES[drag.mode] ? handPlan(drag) : null };
      if (!(o && o.release === false)) onUp(ev(tiles[tiles.length - 1]));
      return { ok: true, mid, after: { drag: drag && drag.mode, pick: !!dropPick } };
    },
    release: (tile) => { if (drag) onUp(__test__._tileEvent(tile || [drag.cur.tx, drag.cur.ty])); return { drag: drag && drag.mode, pick: !!dropPick }; },
    rightClick: (tile) => { onDown(__test__._tileEvent(tile, 2)); return { hand: hand && hand.t }; },
    hover: (tile) => { const e = __test__._tileEvent(tile); onMove(e); return { hoverPropId, hoverTile }; },
    key: (key, o) => { const e = Object.assign({ key, target: null, preventDefault() {}, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, o || {}); onKey(e); return { hand: hand && hand.t, alt: altOn() }; },
    keyUp: (key) => { onKeyUp({ key, preventDefault() {} }); return { alt: altOn() }; },
    pick: (t) => { commitDropPick(t); return { pick: !!dropPick }; },
    // one synchronous frame (the hidden preview pane never fires requestAnimationFrame)
    // (it takes over the pending frame: frame() schedules the next one itself, so a harness calling this never stacks
    //  a second requestAnimationFrame chain — every extra chain re-ran the whole frame per vsync and faked a slowdown)
    frame: () => {
      if (running) {
        if (raf) cancelAnimationFrame(raf), raf = 0;
        if (frameRetryTimer) clearTimeout(frameRetryTimer), frameRetryTimer = 0;
        frame(performance.now());
      }
      return root ? root.dataset.renderState : null;
    },
    // the build feel (2026-10-01): what is landing / dissolving right now — CDP proof reads these mid-animation
    feel: () => ({ landing: [...landings.keys()], vanishing: vanishing.length, selected: selectedPropId }),
    // MANY AT ONCE: the ids selected right now (one, a group, or none)
    selection: () => selectionIds(),
    /* THE HAND part 2: the belts the selection took, what is in hand to paste (and its ghost verdict at a tile), and a REAL
       double-click on a tile (onDblClick — the handler the canvas's dblclick runs) */
    selectionBelts: () => { const b = beltSel(); return b ? { links: b.links.slice(), tiles: b.tiles.length, cells: b.cells.length } : null; },
    clip: (tile) => {
      if (!(tool === 'dupe' && dupe && dupe.type === 'lines')) return lastCopy && lastCopy.type === 'lines' ? { held: false, label: lastCopy.label, n: lastCopy.clip.n, nb: lastCopy.clip.nb } : null;
      const g = tile ? clipGhost(tile[0], tile[1]) : null;
      return { held: true, label: dupe.label, n: dupe.clip.n, nb: dupe.clip.nb, rot: dupe.rot | 0, w: dupe.clip.w, h: dupe.clip.h, ghost: g && { ok: !!g.v.ok, short: g.v.short || g.v.msg || null, ax: g.ax, ay: g.ay, badNodes: g.badNodes.size, badTiles: g.badTiles.size },
        // (wave 2: the layout engine's answer the red ghost says — 'asking' until the pointer has rested, then { ok, msg })
        laid: g && !g.v.ok && layable(dupe.clip) ? (r => r === undefined ? 'asking' : { ok: !!r.ok, msg: r.msg || null })(clipLaidFor(tile[0], tile[1])) : null };
    },
    dblClick: (tile) => { onDblClick(Object.assign(__test__._tileEvent(tile), { preventDefault() {} })); return { selection: selectionIds(), belts: (beltSel() || { links: [] }).links.length }; },
    click: (tile, o) => { const e = Object.assign(__test__._tileEvent(tile), o || {}); onDown(e); onUp(e); return { tool, selection: selectionIds() }; },
    // the armed tool (select = nothing armed) — CDP proof scripts assert the deselect gestures on this
    tool: () => tool,
    // the live WorldModel — for CDP verify scripts to lay a floor through the REAL validated
    // mutation API (setBelt/addProp/assignPropAgent), never by poking doc internals.
    station: () => station || (opts && typeof opts.getStation === 'function' ? opts.getStation() : null),
    placeCapProp: (type) => {
      if (!running || !station) return { ok: false, reason: 'not-in-build' };
      const t = type || 'workbench';   // a real cap-prop id (CAP_PROP_MAP): workbench→terminal, comms_dish→web
      const s = propSpec(t);
      const tile = findPlaceableTile(t, s.w, s.h);
      if (!tile) return { ok: false, reason: 'no-valid-tile' };
      propType = t; tool = 'prop';
      const res = station.addProp({ t, x: tile.tx, y: tile.ty, w: s.w, h: s.h, block: s.blocks !== false });
      return { ok: !!(res && res.ok), tile, type: t };
    },
    // client-pixel for a tile CENTER, inverting the live camera (screen = world*zoom + pan) so a
    // synthetic pointer lands exactly on [tx,ty] — same math toWorldTile uses, run backwards.
    _tileEvent: ([tx, ty], button) => {
      const t = T(), r = cv.getBoundingClientRect();
      return { button: button == null ? 0 : button, pointerId: 1,
        clientX: r.left + ((tx + 0.5) * t * zoom + panX) * (r.width / cv.width),
        clientY: r.top + ((ty + 0.5) * t * zoom + panY) * (r.height / cv.height) };
    },
    // drive a REAL reclaim gesture (onDown→onMove→onUp) across a tile list — proves the belt
    // drag-to-clear path end to end (accumulate cells → filter to belts → removeBelts → one undo).
    reclaimDrag: (tiles) => {
      if (!running || !station || !cv || !tiles || !tiles.length) return { ok: false, reason: 'not-in-build' };
      selectTool('reclaim');
      const before = station.belts().length;
      onDown(__test__._tileEvent(tiles[0]));
      for (let i = 1; i < tiles.length; i++) onMove(__test__._tileEvent(tiles[i]));
      onUp(__test__._tileEvent(tiles[tiles.length - 1]));
      return { ok: true, before, after: station.belts().length };
    },
    /* drive a REAL place gesture (onDown→onMove→onUp) with a tool armed, and hand back the room the
       station actually gained. This is the seam the snap proof needs: asserting snapFit() directly
       would prove the arithmetic and nothing about whether the GHOST and the COMMIT agree, which is
       the half that silently breaks (the ghost shows flush, the click lands one tile off). Drives
       the same three handlers a mouse does, so both go through it. `mode` is 'room' or 'hall'. */
    placeDrag: (mode, from, to) => {
      if (!running || !station || !cv) return { ok: false, reason: 'not-in-build' };
      selectTool(mode === 'hall' ? 'hall' : 'room');
      const before = new Set(station.rooms().map(r => r.id));
      onDown(__test__._tileEvent(from));
      onMove(__test__._tileEvent(to));
      onUp(__test__._tileEvent(to));
      const made = station.rooms().find(r => !before.has(r.id));
      return { ok: !!made, requested: { from, to },
        rects: made ? made.rects.map(r => ({ ...r })) : null, kind: made ? made.kind : null };
    },
    // the ghost's CURRENT rect — so a proof can assert the ghost and the commit agree, not just one
    ghostRects: () => { const g = ghostInfo(); return g && g.rects ? g.rects.map(r => ({ ...r })) : null; },
    footprint: () => structureGhost(ghostInfo()),
    // finish-the-line card readout for CDP proof scripts: the EXACT DOM state the card renders
    finCard: () => (finCardEl ? {
      key: finComp && finComp.key,
      display: finCardEl.style.display !== 'none',
      left: finCardEl.style.left, top: finCardEl.style.top,
      steps: [...finCardEl.querySelectorAll('.fl-step')].map(b => ({
        act: b.dataset.act, txt: b.textContent.trim(),
        done: b.classList.contains('done'), off: b.classList.contains('off'), disabled: b.disabled,
        tip: b.getAttribute('title') || b.getAttribute('data-tip') || null,
      })),
    } : null),
    finRegistry: () => finRead(station),
    /* TEST-RIDE readouts for CDP proof scripts (conveyor-audit 2026-08-10). rideMouth runs the
       REAL reach-aware picker (null agentId = the lineless ▸ PREVIEW pick, WORLD tiles); ride()
       reports the one-shot arming + the live preview crates and captions — where the ride
       actually entered, straight from the engine, never a screenshot of the animated canvas. */
    rideMouth: (agentId) => rideMouthFor(agentId || null),
    ride: () => ({
      pending: ridePending, timer: !!rideTimer, agentId: rideAgentId, seen: rideSeen(),
      boxes: convey ? convey.peekBoxes().filter(b => b.payload && b.payload.test)
        .map(b => ({ x: b.x, y: b.y, tag: (b.payload && b.payload.tag) || null, outbound: !!(b.payload && b.payload.outbound) })) : [],
      notes: testNotes.map(n => ({ x: n.x, y: n.y, text: n.text })),
    }),
    /* PLACEMENT readouts for CDP proof scripts — the EXACT state the wash and the snap run on.
       lineField reports the cached candidate set (count + a bounded sample, never the whole list);
       lineSnapAt answers what a click at a tile would actually commit. */
    lineField: (bpId) => {
      const f = lineField(bpId || lineType);
      return f ? { bp: bpId || lineType, count: f.list.length, runs: f.runs.length, sample: f.list.slice(0, 8) } : null;
    },
    lineFits: (bpId) => lineFits(bpId || lineType),
    lineSnapAt: (tx, ty) => lineSnap(tx, ty),
    // which draw layers have failed this session (empty = every layer is painting)
    degradedLayers: () => Object.keys(layerFailed),
    /* FRAME COST INSTRUMENT — perf(true) starts accumulating, perf(false) stops and returns the
       totals: { '=FRAME': {n, ms}, grid: {…}, props: {…}, … }. Off = a null test per layer. */
    perf: (on) => {
      if (on === false) { const o = perfAcc; perfAcc = null; return o; }
      perfAcc = Object.create(null);
      return true;
    },
    perfRead: () => (perfAcc ? JSON.parse(JSON.stringify(perfAcc)) : null),
    // the per-edit memo generation — a harness can prove a cache actually invalidated on an edit
    geoVer: () => geoVer,
    // camera + the dock/top insets, so a harness can assert framing against the VISIBLE glass
    camera: () => ({ zoom, panX, panY, cw: cv ? cv.width : 0, ch: cv ? cv.height : 0, tile: T(), ins: viewInsets() }),
    // ghost-projection readout (Phase 3) — the EXACT state the projection runs on (boxes/captions/log)
    ghost: () => (ghost ? ghost.peek() : null),
    // run the REAL hover path over a tile and report what the reclaim highlight would target
    // (a belt tile lights the belt, not the room under it).
    hoverAt: (tile) => {
      if (!running || !cv) return null;
      selectTool('reclaim');
      onMove(__test__._tileEvent(tile, 0));
      return { hoverTile, onBelt: !!(hoverTile && station.beltAt(hoverTile.tx, hoverTile.ty)) };
    },
  };

  // REQUISITION — place a prop programmatically through the SAME validated path as a hand placement
  // (findPlaceableTile → station.addProp), firing the same flash/chime/first-touch hooks, so the tutorial's
  // "requisition the rest" is a REAL placement (object=capability stays honest — never a flag). Only while
  // BUILD MODE is open (the kit-out's context); editable/config props are refused (they'd open an editor
  // mid-ceremony). Returns { ok, tile? , reason? }.
  function requisition(t) {
    if (!running || !station) return { ok: false, reason: 'not-in-build' };
    if (!t || isEditableProp(t)) return { ok: false, reason: 'needs-config' };
    const s = propSpec(t);
    const tile = findPlaceableTile(t, s.w, s.h);
    if (!tile) return { ok: false, reason: 'no-valid-tile' };
    const res = station.addProp({ t, x: tile.tx, y: tile.ty, w: s.w, h: s.h, block: s.blocks !== false });
    if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || 'rejected' };
    pushFlash([{ x1: tile.tx, y1: tile.ty, x2: tile.tx + s.w - 1, y2: tile.ty + s.h - 1 }], false);
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(t) : null;
    if (grant) sfx('chime');   // a capability just came online — same brighter note as a hand placement
    if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }   // resolve+fold now: a gap this requisition closes celebrates on its own edge
    if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced(t);
    return { ok: true, tile };
  }

  // deep-link: open BUILD MODE straight into a placed prop's editor. The live world's "NO AGENT — CLICK"
  // bay nag lands here, so the fix is one click away from the callout instead of a hunt through modes.
  function openAssign(propId) {
    if (!running) open();     // open() resolves `station` from opts.getStation() — MUST run before the guard
    if (!station) return;     // (guard-first was a real shipped bug: the click-nag path no-opped on any session that had never opened BUILD MODE)
    const p = station.propById(propId);
    if (!p) return;
    openPropEditor(propId, p.t, { clientX: (window.innerWidth / 2) | 0, clientY: 120 });   // synthetic anchor for the action tip
  }

  /* lineOfAgentInfo(agentId) -> { lineId, name, docks, index, order:[agentId…] } or null (2026-08-22).
     WHICH LINE DOES THIS DOCK'S AGENT RUN, read the way the sidecar reads it: the SAME Pipeline compile of
     the SAME station geometry (Pipeline.lineOf is what router.lineOfAgent quotes when a runsLine routine
     fires), never a guess from prop adjacency. The ROUTINES rows use it to say "runs the <NAME> line from
     <dock> (N docks)" for a routine whose record carries runsLine — the line itself is looked up live, so a
     floor edit that drops the dock honestly returns null and the row falls back to "runs as". */
  /* (multi-bay, 2026-09-22) the walk is by DOCK: `order` lists the agent crewing each dock in run order (an agent
     crewing two bays appears twice), `dockOrder` the bays themselves, and `index` is the position of the named
     dock (a routine's job.dockId), else of the agent's ENTRY dock. */
  function lineOfAgentInfo(agentId, dockId) {
    try {
      const st = station || (opts && typeof opts.getStation === 'function' ? opts.getStation() : null);
      if (!st || !agentId || typeof Pipeline === 'undefined' || !Pipeline.lineComponents) return null;
      const geo = st.projectGeometry();
      const plan = Pipeline.compileRoutingPlan(geo);
      const L = Pipeline.dockLayer ? Pipeline.dockLayer(plan) : null;
      const want = (dockId && L && L.agentOfDock[dockId] === agentId) ? dockId : (L && L.entryDock[agentId]) || null;
      const comp = (Pipeline.lineComponents(geo) || []).find(c => c.bays.some(b => b.agentId === agentId && (!want || b.propId === want)))
        || (Pipeline.lineComponents(geo) || []).find(c => c.bays.some(b => b.agentId === agentId));
      if (!comp) return null;
      let name = null;
      for (const iid of comp.intakes) { const ip = st.propById(iid); if (ip && ip.label) { name = ip.label; break; } }
      const bound = comp.bays.filter(b => b.agentId), pids = bound.map(b => b.propId), seen = {}, dockOrder = [];
      const reach = (L && L.reachDock) || {}, chains = (L && L.dockChains) || {};
      const q = pids.filter(d => reach[d]);
      while (q.length) { const d = q.shift(); if (seen[d] || pids.indexOf(d) < 0) continue; seen[d] = true; dockOrder.push(d); for (const n of ((chains[d] && chains[d].next) || [])) q.push(n); }
      for (const d of pids) if (!seen[d]) { seen[d] = true; dockOrder.push(d); }
      const agentOf = {}; for (const b of bound) agentOf[b.propId] = b.agentId;
      const order = dockOrder.map(d => agentOf[d]);
      const at = want && dockOrder.indexOf(want) >= 0 ? dockOrder.indexOf(want) : order.indexOf(agentId);
      return { lineId: comp.key, name, docks: bound.length, index: at, order, dockOrder };
    } catch (e) { return null; }
  }
  // Optional authored skins arrive after the UI scripts. Refresh only the art
  // preview and thumbnails; selection, orientation and station data stay intact.
  if (typeof window !== 'undefined' && window.addEventListener) {
    // a made prop joined (or its art arrived): repaint the catalog so MADE BY YOU and its tile appear
    window.addEventListener('starnet:userprops-changed', () => {
      if (!root || !(tool === 'prop' || (tool === 'select' && buildGroup === 'props'))) return;
      renderPalette();
    });
    window.addEventListener('starnet:prop-art-ready', () => {
      mountOrder = null; // Loaded support geometry can change host-relative sorting without an edit.
      if (!root) return;
      const host = root.querySelector('#refit-selected-prop');
      if (host) delete host.dataset.previewKey;
      renderPropPreview(); paintThumbs(0,true);
    });
  }

  /* WORK › AUTOMATE › WORKFLOWS (2026-09-27 audit F1): the conveyor builder had no door named for what people come to do. This one opens
     BUILD MODE on the Conveyors tab and, when the floor already has a line, docks that line's Workflow panel so its sentence and
     steps are the first thing on screen; with no line yet the CONVEYOR LINES library is what shows. */
  function openWorkflows() {
    pendingGroup = 'workflow'; writeLastGroup('workflow');
    if (!running) open(); else { buildGroup = 'workflow'; selectTool('select'); }
    if (!running || !station) return;
    // the panel names the line from the compiled line groups (valComps): compile NOW, or it opens on a bare "single BAY"
    try { rebake(); } catch (e) { /* the frame loop compiles on its next tick; the panel repaints when it does */ }
    /* ONE DOOR TO SET UP A PRESET (2026-09-28): while a work preset's line still has a step nobody works, WORKFLOWS opens its
       setup guide (who works each step + the sample job) — the onboarding pick's closing line points here. Once every
       step is staffed it opens the Workflow panel as always. */
    const ex = currentPresetExample();
    if (ex && ex.roles.length && ex.roles.some(r => !r.agentId)) { openPresetExample(); return; }
    const first = station.props().find(p => p.t === 'intake') || station.props().find(p => p.t === 'bay');
    if (first && typeof WorkflowPanel !== 'undefined') { try { openFlowCard(first.id); } catch (e) {} }
    else if (!first) { try { selectTool('line'); } catch (e) {} }
  }
  /* EDIT WORKFLOW (2026-09-30): the WORKFLOWS window's door into the full editor — BUILD MODE open on the floor with THIS line's own
     Workflow panel on screen (the diagram, every step's instructions, what starts it, its budget, floor edits). */
  function editLine(propId) {
    pendingGroup = 'workflow'; writeLastGroup('workflow');
    if (!running) open(); else { buildGroup = 'workflow'; selectTool('select'); }
    if (!running || !station || !station.propById(propId)) return false;
    try { rebake(); } catch (e) { /* the frame loop compiles on its next tick; the panel repaints when it does */ }
    try { openFlowCard(propId); } catch (e) { return false; }
    return true;
  }
  const api = { init, open, openWorkflows, editLine, testJobForProp, close, toggle, isOpen, requisition, refitNames: guideNames, openAssign, placeDeskFor, noteLineShipped, markLineShipped, lineShipSpent, lineOfAgentInfo, summonForRole, nagLabel: code => VAL_LABEL[code] || code,
    // the WORKFLOWS window speaks the shelf's own words and shows the shelf's own art (one name per line, never a second one)
    lineWords: () => ({ plain: LINE_PLAIN, purpose: LINE_PURPOSE }), lineSchematic: bp => lineSchematic(bp), machineStill: t => machineStill(t),
    // (org P18) the shelf's FOR YOUR GOAL line, for WORKFLOWS › NEW WORKFLOW to lead with (null when no belief names a shape)
    goalLine: () => { const g = goalLine(); return g ? { id: g.bp.id, why: g.why, quote: g.quote } : null; },
    nagWhy: valWhy };   // nagLabel: the floor's own nag copy for a compiler code (ROUTINES RUN NOW refusal reads it); nagWhy: the full fix sentence the hover card + Workflow panel say (station.layout reads it)
  if (typeof window !== 'undefined' && window.__STARNET_DEV__) api.__test__ = __test__;
  return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Build;
