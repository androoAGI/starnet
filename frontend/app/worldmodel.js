/* STARNET — worldmodel.js : the canonical, mutable, serializable STATION document.

   This is the single source of truth the builder edits and that both the renderer
   (via projectGeometry → stationbake.js) and the future AgentOrg runtime read.

   PURITY CONTRACT (so it stays headless-testable and deterministic):
     - no DOM, no canvas, no `window`/`document`
     - no ambient wall-clock or RNG — ids are a per-document counter, timestamps are injected
   It only depends on the global `U` (util.js: U.clamp/U.shade/U.hash) — none of which are
   non-deterministic. See frontend/app/BUILDER.md for the full contract.

   The model stores LOGICAL geometry in signed world-tile coords (unbounded; the station can
   grow in any direction). `projectGeometry()` emits the v7 MAP-shaped object the bake consumes,
   shifted into a non-negative local frame with a margin for the hull. */
'use strict';

const WorldModel = (() => {
  /* MOUNT RULES lookup, injected once at module level (NOT per station instance) — a per-instance
     setter would have to be re-armed at every create()/deserialize()/undo-clone site, and the one
     that got missed would silently place wall props in open floor. Null = no rules installed, which
     is the plain-node/test case: every prop is placeable on bare deck exactly as before. */
  let propRules = null;
  function setPropRules(fn) { propRules = (typeof fn === 'function') ? fn : null; }
  // the ONE line-budget normalizer (pipeline.js): the browser global, or the module in node tests. Absent
  // (no compiler loaded) -> limits are dropped rather than stored raw: a number no executor normalized never rides a save.
  // the ONE compiler (browser global or node require) — read lazily so load order never matters
  function pipelineModule() {
    let P = (typeof Pipeline !== 'undefined') ? Pipeline : null;
    if (!P && typeof require === 'function') { try { P = require('./pipeline.js'); } catch (_) { P = null; } }
    return P;
  }
  function normalizeLimits(raw) {
    const P = pipelineModule();
    return (P && typeof P.normalizeLineLimits === 'function') ? P.normalizeLineLimits(raw) : null;
  }
  const TILE = 12;
  const MARGIN = 3;     // tile padding around the bounding box (hull extrusion + chamfer arcs need room)
  const MIN_ROOM = 3;   // min room floor side, in tiles
  const MIN_HALL = 2;   // min hallway length, in tiles (long axis)
  const MAX_SPAN = 240; // max station footprint span per axis (keeps the bake canvas bounded)
  const HULL_PAD = 14;  // extra canvas px below the grid for the south hull extrusion (matches v7 H = ROWS*T+14)

  /* FILTER/MERGER junction config carried on a prop (additive, like a BAY's agentId; the pipeline reads
     routes/def for filters, bufferSize for mergers). Sanitized so a hand-edited save can never inject a bad lane. */
  const JDIRS = { E: 1, W: 1, N: 1, S: 1 };
  const cleanDir = d => (JDIRS[d] ? d : null);
  function cleanRoutes(r) {
    if (!r || typeof r !== 'object') return null;
    const out = {}; let n = 0;
    for (const k in r) { const key = String(k).slice(0, 24); if (key && JDIRS[r[k]]) { out[key] = r[k]; n++; } }
    return n ? out : null;
  }
  const cleanBuf = b => { const n = b | 0; return n >= 2 ? n : null; };

  /* PROP ORIENTATION (additive, like block/agentId/door). The model stays PURE — it does not know the
     catalog, so it does not police WHICH props may turn; that is the renderer's call
     (PropSprites.canRotate / facings) and the builder only ever offers a facing the art can honestly
     draw. Here we store intent and keep it well-formed: `r` = quarter turns clockwise 0..3, `m` =
     mirrored. Both are omitted at their defaults so an unturned prop serializes byte-identical to
     before. NOTE the footprint w/h on the record are already the EFFECTIVE (turned) dims — the
     builder swaps them at placement when, and only when, the art re-tiles. That is deliberate: every
     consumer of a prop rect (canPlaceProp, blockedTiles, propFootprint, PropAnchor.sideTiles,
     hit-testing, DUPE) keeps reading w/h and needs no knowledge of r at all, so orientation stays
     contained to the renderer and the builder. */
  const cleanRot = v => ((v | 0) & 3);
  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // notebook/fs-jail agentId grammar (mirrors the sidecar hub)
  const WHEN_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
  function cleanPipelineEdge(e) {
    if (!e || typeof e !== 'object') return null;
    const from = String(e.from || '').trim();
    const to = String(e.to || '').trim();
    const whenKind = String(e.whenKind || 'handoff').trim();
    if (!AID_RE.test(from) || !AID_RE.test(to) || from === to || !WHEN_RE.test(whenKind)) return null;
    const out = { from, to, whenKind };
    const lane = String(e.lane == null ? '' : e.lane).trim();
    if (lane) {
      if (!WHEN_RE.test(lane)) return null;
      out.lane = lane;
    }
    return out;
  }
  // copy any present + valid junction config from src onto dst (mutates dst; additive — absent fields untouched)
  function applyJunctionCfg(dst, src) {
    const routes = cleanRoutes(src.routes); if (routes) dst.routes = routes;
    const def = cleanDir(src.def); if (def) dst.def = def;
    const buf = cleanBuf(src.bufferSize); if (buf) dst.bufferSize = buf;
    // JOINER / LOOP gate config (2026-08-21): bounded ints + a lane dir + a tag, same sanitizing discipline
    const tm = Math.floor(+src.timeoutMin); if (isFinite(tm) && tm >= 1 && tm <= 120) dst.timeoutMin = tm;
    const mx = Math.floor(+src.maxIter); if (isFinite(mx) && mx >= 1 && mx <= 20) dst.maxIter = mx;
    const done = cleanDir(src.done); if (done) dst.done = done;
    const esc = cleanDir(src.esc); if (esc) dst.esc = esc;   // LOOP escalation lane (2026-08-30)
    if (typeof src.when === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(src.when)) dst.when = src.when;
    return dst;
  }

  /* Airlock door state — a SPATIAL room-seal mechanic, carried on an 'airlock' prop exactly like a BAY
     carries agentId. A room containing a SEALING airlock (closed|jammed) is cut off ON THE FLOOR:
     projectGeometry drops its boundary doors so canStep — and thus every agent BODY path — can't cross in
     or out. It's a staging seal (an unmerged-branch metaphor); it does NOT change the agent's run, tools, or
     capabilities (the BAY governs those). The room is visually private until "merged".
       open   = connected to trunk (DEFAULT — stored as an absent field, so old docs are unchanged)
       closed = private, sealed
       jammed = a merge conflict (sealed + a red spark on the prop) */
  const DOOR_STATES = { open: 1, closed: 1, jammed: 1 };
  const cleanDoor = s => (DOOR_STATES[s] ? s : null);
  const doorSeals = s => s === 'closed' || s === 'jammed';

  /* Phase B5 — object = capability, made real on the placed floor. A prop type maps to a CAP_REGISTRY
     objectType (computer=compute · cabinet=files · dish=web · notebook=memory); the props in a BAY's room are
     that agent's grants (via the sidecar's resolveTools). DATA, deliberately tunable — only a few intuitive
     props grant reach; everything else is inert decor. A bay with no `computer` prop can't run (compute gate
     stays shut = cost-safe), which the REFIT validator surfaces as NO COMPUTE. */
  const CAP_PROP_MAP = {
    console: 'computer', consoleL: 'computer', desk: 'computer', desk2: 'computer', pixelrig: 'computer', bench: 'computer',  // a workstation = compute
    war_intelcab: 'cabinet', safe: 'cabinet', vault: 'cabinet', rack: 'cabinet', shelf: 'cabinet',                            // a locked cabinet = files
    comms_dish: 'dish', comms_uplink: 'dish', comms_beacon: 'dish',                                                           // a comms dish = web
    gigs_servercart: 'notebook', bridge_relaystack: 'notebook', core: 'notebook',                                            // a server/databank = memory
    connector_portal: 'connector',                                                                                           // a connector portal = an MCP server's live tools (per-instance, bound to a connectorId)
    plugin_terminal: 'plugin',                                                                                               // a plugin terminal = that plugin's tools (per-instance, bound to a pluginId) + opens its window
    workbench: 'workbench',                                                                                                   // a workbench = shell.exec + verify.run (real code execution, consent-gated)
    studio: 'studio',                                                                                                         // a media studio = image_generate / image_analyze (G1b: image tools finally have a placeable body)
    jukebox: 'jukebox'                                                                                                        // a jukebox = Spotify tools (search/now-playing/play/pause/queue); INERT until Spotify is connected in TOOLSETS
  };

  /* the plain-English POWER each capability grants — one OWNED source of truth so the palette tile, the
     placement toast, and the Field Manual all say the SAME word for the same thing (kills DISH-vs-antenna
     drift: a prop, the power it grants, and what the agent then does all match). */
  const CAP_LABEL = {
    computer: 'COMPUTE', cabinet: 'FILES', dish: 'WEB', notebook: 'MEMORY', connector: 'LIVE TOOLS', workbench: 'TERMINAL', studio: 'IMAGES', jukebox: 'SPOTIFY', plugin: 'PLUGIN TOOLS'
  };
  function grantLabelForProp(propType) { const c = CAP_PROP_MAP[propType]; return c ? (CAP_LABEL[c] || c) : null; }   // prop -> plain power word (or null = inert decor)

  /* the paint palette — each is a floor BASE colour; every other floor detail
     (seams / rivets / vents / hatches) is derived from it via U.shade in the bake.
     The COLOURED bases stay in a dark low-value SUBSTRATE band (floor, not accent light) so the
     CRT phosphor + warm room-light pools read on top — their variety comes from spreading the HUE
     across the wheel, not from brightness. bone + onyx are the deliberate exceptions: the bright
     and near-black ends of the value range, for decks that want stark contrast. This catalog is the
     sole source: add a colour here and it appears in the SURFACE palette's COLOUR row AND as a room floor
     style automatically. */
  const FLOOR_STYLES = {
    // 2026-09-02: hull #33302a -> #3c3429, decking #2c2924 -> #342d25. The stock hab is what every
    // new station boots on and it measured the greyest room in the building (mean chroma 11 on a
    // furnished floor vs 22 on oak). Same value band, a notch of warmth — the lamp pools finally
    // have a colour to land on. Every other swatch is untouched.
    hull:     { base: '#3a3b41', label: 'HULL' },
    corridor: { base: '#31333a', label: 'DECKING' },
    cobalt:   { base: '#2b3340', label: 'COBALT' },
    rust:     { base: '#3a302a', label: 'RUST' },
    sterile:  { base: '#34383a', label: 'STERILE' },
    crimson:  { base: '#3a2b2b', label: 'CRIMSON' },
    verdant:  { base: '#2c3a2e', label: 'VERDANT' },
    // extended spectrum — warm → cool, same dark substrate band, each a distinct hue
    ember:    { base: '#402a1c', label: 'EMBER' },
    amber:    { base: '#3c3420', label: 'AMBER' },
    moss:     { base: '#34391f', label: 'MOSS' },
    teal:     { base: '#213a3c', label: 'TEAL' },
    indigo:   { base: '#282a48', label: 'INDIGO' },
    violet:   { base: '#332941', label: 'VIOLET' },
    orchid:   { base: '#3e2a3a', label: 'ORCHID' },
    // natural tones — the hues the PLANK / TURF materials were drawn for. Same dark substrate
    // band as everything above: a wood deck is a DARK wood deck, so the room-light pools still
    // read on top of it. (Any material still renders in any hue — these are just the fitting ones.)
    walnut:   { base: '#3b2b20', label: 'WALNUT' },
    oak:      { base: '#46372a', label: 'OAK' },
    ash:      { base: '#3a3630', label: 'ASH' },
    fern:     { base: '#2a3f24', label: 'FERN' },
    // MEADOW — fern's warm twin, added for TURF (2026-07-25). Real grass is olive: red and green
    // close together with blue well under both. FERN is a blue-leaning green, and because vivid()
    // drives the DOMINANT channel hardest, its lifts run toward pure green rather than the
    // yellow-green of a lawn. Raising red and dropping blue is what buys the olive.
    meadow:   { base: '#374024', label: 'MEADOW' },
    // value poles — the bright + near-black ends of the range (stark, deliberate)
    bone:     { base: '#e7e3d9', label: 'BONE' },
    /* WHITE — bone's neutral twin, added 2026-08-05 for the SHELL axis (Andrew: "lets add white as a
       colour for the shell"). BONE is a warm cream; this is the achromatic pole, which is what reads
       as PAINT rather than as stone. It matters most on a hull: the exterior is the one surface with
       no ambient over it, so it is the only place a white actually stays white — and a whitewashed
       STUCCO or CLAPBOARD building is the point of having it. See the bright-pole band in
       stationbake's vacuum(), which is what keeps it from being clamped into the dark shell band
       along with every ordinary hue. */
    white:    { base: '#f2f0ea', label: 'WHITE' },
    onyx:     { base: '#0e0e12', label: 'ONYX' },
  };

  /* the deck MATERIAL catalog — the second floor axis, orthogonal to colour.
     FLOOR_STYLES picks the HUE; this picks the RECIPE the bake draws in that hue (plate seams,
     grate holes, wood grain, grass blades...). Both compose: every material derives its marks
     from the tile's own base via U.shade, so a TURF deck painted COBALT is blue grass — odd,
     but coherent and the user's call. `pitch` is the plate/plank cell in tiles; `suggest` is the
     hue the SURFACE palette pre-selects when you pick that material (a UI convenience only — the
     model never forces a colour). This catalog is the sole source: add a material here, give it
     a recipe in stationbake, and it appears in the SURFACE palette's MATERIAL row automatically. */
  const FLOOR_MATERIALS = {
    // the hab default since 2026-07-25 — see the note above deckSpine in stationbake.js
    spine: { label: 'SPINE',  pitch: [4, 3], suggest: null },
    alloy: { label: 'ALLOY', pitch: [4, 3], suggest: 'hull' },
    plate: { label: 'PLATE',  pitch: [2, 2], suggest: null },
    panel: { label: 'PANEL',  pitch: [4, 1], suggest: null },
    tile:  { label: 'TILE',   pitch: [2, 2], suggest: null },
    tread: { label: 'TREAD',  pitch: [2, 2], suggest: null },
    soft:  { label: 'MATTED', pitch: [3, 2], suggest: null },
    // v4 additions — the decks that don't look like the old station
    grate: { label: 'GRATE',  pitch: [1, 1], suggest: 'onyx' },
    hex:   { label: 'HEX',    pitch: [1, 1], suggest: 'sterile' },
    plank: { label: 'PLANK',  pitch: [5, 1], suggest: 'walnut' },
    turf:  { label: 'TURF',   pitch: [1, 1], suggest: 'meadow' },
    // v6 CORRIDOR candidates — decks sized and surfaced for a passage rather than a room.
    // See the note above deckRunner in stationbake.js.
    // 2026-09-03 additions — painters live above paintDeck in stationbake.js
    diamond: { label: 'DIAMOND', pitch: [1, 1], suggest: null },
    resin:   { label: 'RESIN',   pitch: [4, 4], suggest: 'sterile' },
    ceramic: { label: 'CERAMIC', pitch: [3, 3], suggest: 'bone' },
    cargo:   { label: 'CARGO',   pitch: [3, 2], suggest: 'rust' },
    runner:   { label: 'RUNNER',   pitch: [2, 2], suggest: null },
    treadway: { label: 'TREADWAY', pitch: [3, 2], suggest: null },
    meshway:  { label: 'MESHWAY',  pitch: [3, 3], suggest: null },
    // Cut-stone slabs, herringbone wood and ribbed industrial mat.
    basalt:   { label: 'BASALT',   pitch: [3, 2], suggest: 'hull' },
    parquet:  { label: 'PARQUET',  pitch: [3, 3], suggest: 'walnut' },
    rubber:   { label: 'RUBBER',   pitch: [2, 2], suggest: 'corridor' },
    slotted:  { label: 'SLOTTED',  pitch: [3, 2], suggest: 'corridor' },
    terrazzo: { label: 'TERRAZZO', pitch: [4, 4], suggest: 'hull' },
    octile:   { label: 'OCTILE',   pitch: [2, 2], suggest: 'sterile' },
    flightdeck: { label: 'FLIGHT DECK', pitch: [2, 2], suggest: 'hull' },
    lunar: { label: 'LUNAR', pitch: [4, 2], suggest: 'sterile' },
    maggrid: { label: 'MAG GRID', pitch: [2, 2], suggest: 'corridor' },
    habitat: { label: 'HABITAT', pitch: [2, 2], suggest: 'corridor' },
  };
  const MAT_ORDER = ['spine', 'alloy', 'runner', 'treadway', 'meshway', 'plate', 'diamond', 'cargo', 'panel', 'tile', 'ceramic', 'resin', 'tread', 'soft', 'grate', 'hex', 'plank', 'turf', 'basalt', 'parquet', 'rubber', 'slotted', 'terrazzo', 'octile', 'flightdeck', 'lunar', 'maggrid', 'habitat'];

  /* the WALL material catalog — the deck's opposite number. Walls carry the same two axes as the
     floor (hue × recipe) and read from the same FLOOR_STYLES hue catalog, because a room should be
     able to be cobalt all the way up. `room.wallStyle` null means "follow this room's floor hue",
     which is what makes a freshly-built station instantly varied instead of one brown-grey box.
     `viewport` is the odd one out: it doesn't PAINT the wall, it punches a hole in it — the bake
     leaves those pixels transparent so the live drifting starfield behind the station shows
     through. Baked stars would be a lie; the real sky is already back there. */
  const WALL_MATERIALS = {
    // base-wall candidates — see the note above wallBulkhead in stationbake.js
    // the base wall since 2026-07-25 — see the note above wallBulkhead in stationbake.js
    bulkhead: { label: 'BULKHEAD', suggest: null },
    courses:  { label: 'COURSES',  suggest: null },
    service:  { label: 'SERVICE',  suggest: null },
    plating:  { label: 'PLATING',  suggest: null },
    ribbed:   { label: 'RIBBED',   suggest: null },
    panelled: { label: 'PANEL',    suggest: null },
    viewport: { label: 'VIEWPORT', suggest: null },
    pipework: { label: 'PIPEWORK', suggest: null },
    wainscot: { label: 'WAINSCOT', suggest: 'walnut' },
    hedge:    { label: 'HEDGE',    suggest: 'fern' },
    pressure: { label: 'PRESSURE', suggest: 'bone' },
    radiator: { label: 'RADIATOR', suggest: 'hull' },
    utility: { label: 'UTILITY', suggest: 'cobalt' },
    acoustic: { label: 'PADDED', suggest: 'ash' },
    braced: { label: 'BRACED', suggest: null },
    machinery: { label: 'MACHINERY', suggest: null },
    insulation: { label: 'INSULATION', suggest: 'amber' },
  };
  const WALL_ORDER = ['bulkhead', 'courses', 'service', 'plating', 'ribbed', 'panelled', 'viewport', 'pipework', 'wainscot', 'hedge', 'pressure', 'radiator', 'utility', 'acoustic', 'braced', 'machinery', 'insulation'];

  /* the HULL material catalog — THE THIRD SURFACE AXIS (2026-08-05, Andrew, circling the outside
     edges of five rooms in a screenshot: "the outer walls are not customizable... for users who
     want to put their station in the forest, and want a more cabin feel").

     DECK and WALLS dress the INSIDE of a room. The hull is everything you see of it from OUTSIDE:
     the plate that surrounds the footprint, the texture over that plate, the framed rim + bolts,
     the rounded corner arcs, and — the surface that actually reads at a glance — the SKIRT, the
     tall face extruded below the station's silhouette. All five were painted from five hardcoded
     constants, so every room in every station had the identical dark riveted shell. Now the shell
     is per room, which is what makes a mixed station read as a CITY of separate buildings rather
     than one hull with seams in it.

     `suggest` is the hue a material defaults to when the room carries no explicit hullStyle. Unlike
     the wall axis — where `suggest` is only a UI convenience — this one binds in the MODEL, because
     a hull's default has to be a tone the material was drawn for: TIMBER at the station's own
     #191712 is black wood, which is nobody's cabin. `station` alone suggests null, meaning "keep
     the shell's own tone" — the literal legacy constants, so every station already built renders
     pixel-identical until someone paints it.

     Adding one here is the whole job: give it a recipe in stationbake's HULL_RECIPES and it appears
     in the REFIT SURFACE palette's HULL target automatically. */
  const HULL_MATERIALS = {
    station:   { label: 'STATION',   suggest: null,     blurb: 'riveted hull plate — the shell you launched with' },
    monocoque: { label: 'MONOCOQUE', suggest: 'bone', blurb: 'large inset alloy panels with recessed joints and protected edge rails' },
    timber:    { label: 'TIMBER',    suggest: 'walnut', blurb: 'stacked log courses — the cabin' },
    clapboard: { label: 'CLAPBOARD', suggest: 'ash',    blurb: 'lapped siding boards — the farmhouse' },
    shingle:   { label: 'SHINGLE',   suggest: 'oak',    blurb: 'overlapping shingles — a pitched roof from above' },
    brick:     { label: 'BRICK',     suggest: 'ember',  blurb: 'narrow fired-clay masonry with dark recessed mortar' },
    stone:     { label: 'STONE',     suggest: 'ash',    blurb: 'irregular rubble masonry — the cottage' },
    stucco:    { label: 'STUCCO',    suggest: 'amber',  blurb: 'rendered plaster + corner quoins — adobe' },
    curtain:   { label: 'CURTAIN',   suggest: 'indigo', blurb: 'glass curtain wall + mullions — the tower' },
    hedge:     { label: 'HEDGE',     suggest: 'fern',   blurb: 'clipped hedge — the garden wall' },
  };
  Object.assign(HULL_MATERIALS, {
    thermal: { label: 'THERMAL', suggest: 'hull', blurb: 'dark carbon thermal shielding with interlocking armor panels' },
    heatsink: { label: 'HEATSINK', suggest: 'hull', blurb: 'radiator fins between calm graphite cladding panels' },
    truss: { label: 'TRUSS', suggest: 'hull', blurb: 'diagonal structural braces over recessed armor' },
    louver: { label: 'LOUVER', suggest: 'hull', blurb: 'deep chevron intake blades in armored frames' },
    ceramic: { label: 'CERAMIC', suggest: 'bone', blurb: 'pale ceramic-composite plates with graphite joints' }
  });
  const HULL_ORDER = ['station', 'monocoque', 'timber', 'clapboard', 'shingle', 'brick', 'stone', 'stucco', 'curtain', 'hedge', 'thermal', 'heatsink', 'truss', 'louver', 'ceramic'];

  /* room categories — a capability-zone label + a default floor (hue + material). kind drives
     nothing behavioural yet (capability mapping is a later pass); it tags the zone + seeds the
     look. `mat` is the DEFAULT deck material a room of this kind is built with — a room whose
     floorMat is null renders at this material.

     THIS MAP IS THE AUTHORITY on a room's default deck. `MAT_BY_KIND` in stationbake.js looks like
     a second copy but is only a fallback for geometry that arrives without `matOf` — projected
     geometry always carries it, so editing stationbake alone changes NOTHING you can see. Change
     both, and keep them agreeing.

     2026-07-25: hab and corridor moved off `plate` onto `spine` (they must move together or a
     corridor reads as a different floor through the doorway). This DELIBERATELY changes the look of
     every station already built — floorMat is null on all of them — because the default deck is the
     one surface every player sees. `plate` stays in the palette, so the old look is still choosable
     and nothing is destroyed. It also means the Guardian goldens all shift. */
  const ROOM_KINDS = {
    hab:      { label: 'HAB',      floor: 'hull',     mat: 'spine' },
    bridge:   { label: 'BRIDGE',   floor: 'cobalt',   mat: 'panel' },
    lab:      { label: 'LAB',      floor: 'sterile',  mat: 'tile'  },
    factory:  { label: 'FOUNDRY',  floor: 'rust',     mat: 'tread' },
    quarters: { label: 'QUARTERS', floor: 'verdant',  mat: 'soft'  },
    storage:  { label: 'STORAGE',  floor: 'rust',     mat: 'tread' },
    corridor: { label: 'CORRIDOR', floor: 'corridor', mat: 'spine' },
  };
  // a room's effective deck material: explicit override, else the kind default, else plate.
  const matOfRoom = rm => (rm && FLOOR_MATERIALS[rm.floorMat]) ? rm.floorMat
    : ((rm && ROOM_KINDS[rm.kind] && ROOM_KINDS[rm.kind].mat) || 'plate');
  // walls: material defaults to plating; hue defaults to FOLLOWING THE FLOOR, so every room's
  // walls harmonize with its deck without the Commander having to pick twice.
  /* THE AUTHORITY on a room's default wall material (stationbake's `wallMatOf` fallback is only for
     geometry arriving without one). 2026-07-25: moved off `plating` onto `bulkhead` — every room
     carries wallMat null, so this reaches stations already built, deliberately, for the same reason
     the deck default moved. `plating` stays in the palette as the classic. */
  const wallMatOfRoom = rm => (rm && WALL_MATERIALS[rm.wallMat]) ? rm.wallMat : 'bulkhead';
  /* A CORRIDOR'S WALL IS THE STATION'S BULKHEAD, NOT ITS DECKING (2026-07-29, Andrew: "light
     doesn't seem to reflect on the walls of the hallway"). Following the deck is right for a ROOM —
     wall and floor are the same room's finish — but a corridor's floor style is DECKING #2c2924,
     the DARKEST entry in the table, and its wall inherited that on top of two other deliberate
     dimmings (corUp 8 vs up 14, LIGHT.corridor 0.42 vs room 0.6). Stacked, they put a hallway wall
     face at luma 26.5 where a room's reads 39.5 — BELOW what a room wall measures after its own
     ambient, so no amount of light could ever bring it back. That is why the wall read as unlit
     next to a deck that had just been fixed.
     Same law stationbake's sideCap note already states for the wall's top surface: a hallway's
     bulkhead is the same slab of station as the rooms it connects. A wall's HEIGHT may differ
     between space types — that is the tunnel read and it stays — its MATERIAL may not.
     Default only: an explicitly painted wallStyle still wins. */
  const wallStyleOfRoom = rm => {
    if (rm && FLOOR_STYLES[rm.wallStyle]) return rm.wallStyle;
    if (rm && rm.kind === 'corridor') return 'hull';
    if (rm && FLOOR_STYLES[rm.floorStyle]) return rm.floorStyle;
    return 'hull';
  };
  /* THE AUTHORITY on a room's exterior shell (stationbake's HULL_RECIPES fallback is only for
     geometry arriving without one). Defaults to `station` so nothing already built moves. */
  const hullMatOfRoom = rm => rm && rm.hullMat === 'insulation' ? 'thermal' : (rm && HULL_MATERIALS[rm.hullMat]) ? rm.hullMat : 'station';
  /* A HULL'S HUE, or null for "the shell's own tone". Explicit paint wins; otherwise the material's
     own suggested hue (see the HULL_MATERIALS note on why this binds in the model and the wall
     axis's `suggest` does not). A CORRIDOR follows the room it connects only in spirit — it takes
     its own hull like any other footprint, because a covered walkway between a cabin and a brick
     house is a real architectural choice and forcing it either way would take that away. */
  const hullStyleOfRoom = rm => {
    if (rm && FLOOR_STYLES[rm.hullStyle]) return rm.hullStyle;
    const def = HULL_MATERIALS[hullMatOfRoom(rm)];
    return (def && def.suggest) || null;
  };
  const KIND_ORDER = ['hab', 'bridge', 'lab', 'factory', 'quarters', 'storage'];

  /* ---------- pure geometry helpers ---------- */
  const normRect = r => ({
    x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2)
  });
  const rectW = r => r.x2 - r.x1 + 1;
  const rectH = r => r.y2 - r.y1 + 1;
  const rectsHit = (a, b) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2; // inclusive: shares a tile
  const inRect = (r, x, y) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
  const clone = o => JSON.parse(JSON.stringify(o));
  const pad2 = n => String(n).padStart(2, '0');

  /* STATION IDENTITY (2026-08-07 conveyor audit). `meta.createdAt` is the station's DURABLE ID: the
     REFIT one-shots (first ride, ORDERS, the finish-the-line registry) namespace their localStorage
     keys on it, so a second station must not inherit the first one's dismissals. It used to be
     stamped 0 by every path — no caller ever passed one — which made that namespace the constant
     string 'default' and every "per-station" latch global. Stamped once at creation, backfilled once
     on migrate for docs saved before this existed, and never touched again. Injectable so tests and
     any future importer stay deterministic. */
  function stationId() { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 1; }
  /* SAVE VERSION. 2 (2026-09-28, the conveyor-links plan): the doc carries `links` — the explicit machine-to-machine
     connections its belts make (Pipeline.deriveLinks). Belts stay in the save, so an older build that opens a v2 save
     still routes by tiles; this build re-derives the links from the belts on load, so a save an older build edited
     can never carry stale ones. */
  const STATION_VERSION = 2;
  function freshDoc(createdAt) {
    const doc = {
      schema: 'starnet.station', version: STATION_VERSION, _nid: 1,
      meta: { name: 'STARNET STATION', createdAt: createdAt || stationId(), tier: 0, spawnRoomId: null, trunkRoomId: null },
      rooms: {}, order: [], props: [], belts: {}, edges: []
    };
    // seed the shabby starter HAB (18×11 floor — the v7 / world.js starter room), so a new
    // station is never empty and the builder has something to extend from.
    const id = 'r' + (doc._nid++);
    doc.rooms[id] = {
      id, kind: 'hab', name: 'HAB-01',
      rects: [{ x1: 0, y1: 0, x2: 17, y2: 10 }],
      floorStyle: 'hull', floorMat: null, wallStyle: null, wallMat: null, hullStyle: null, hullMat: null, tier: 0, floorPaint: {}
    };
    doc.order.push(id);
    doc.meta.spawnRoomId = id;
    doc.meta.trunkRoomId = id;   // the starter HAB is the integration hub — it never seals
    return doc;
  }

  /* ---------- STARTER-LINE BLUEPRINT CATALOG (static, headless-testable) ----------
     Four whole pre-wired lines. Coordinates are LOCAL to the blueprint's top-left; w/h is the
     bounding footprint (for palette schematics + cursor centering). Machine footprints mirror the
     PropSprites catalog exactly (docks 2×2 solid, junctions 1×1 walkable ON the line); every lane's
     last tile aims INTO its destination footprint so the crate visibly sinks at the dock — the same
     shape connectBelt lays by hand. Each blueprint must compile (pipeline.js compileRoutingPlan)
     to UNBOUND_BAY warns ONLY — locked by test/blueprints.test.js. */
  /* BAY ROLES (guided workflows Phase 1, 2026-08-05): a blueprint bay stamps MEANING, not a blank
     dock — `role` names who should crew it, `desc` says what that crew member does (placard copy),
     `cls` maps to the real Specialties class the one-click summon deploys. The catalog is static
     code (single source for copy + class wiring); the SAVED doc carries only the prop's `role`
     string — see migrate()'s prop whitelist. Role is provenance: it survives binding (a suggestion,
     never a gate — sandbox law), and hand-placed bays simply have none. */
  const BAY_ROLES = {
    RESEARCHER: { desc: 'digs sources & builds the brief', cls: 'researcher' },
    WRITER:     { desc: 'drafts the result',               cls: 'writer' },
    ENGINEER:   { desc: 'works the code lane',             cls: 'engineer' },
    GENERALIST: { desc: 'handles everything else',         cls: 'chief' },
    CREW:       { desc: 'works its share of the stream',   cls: 'chief' },
    SHIPPER:    { desc: 'finishes the job & ships it',     cls: 'chief' },
    REVIEWER:   { desc: 'judges the draft & calls the verdict', cls: 'reviewer' },
    TESTER:     { desc: 'checks the change & calls the verdict', cls: 'reviewer', name: 'TESTER' },   // `name`: a recruit is named for the step, not its class
    ANALYST:    { desc: 'turns the branches into one answer',   cls: 'analyst' },
    FIXER:      { desc: 'takes over when the loop gives up',    cls: 'chief' },
  };
  /* THE SHELF (expanded 2026-08-29). Array order IS shelf order: the simplest working line first,
     then one line per MACHINE the floor owns — FILTER, SPLITTER, LOOP gate, JOINER, MERGER — so a
     Commander meets a mechanic by stamping a line that already uses it correctly instead of wiring
     one from parts. Every entry is held to the same contract by test/blueprints.test.js: stamped
     and crewed it compiles with ZERO errors, so no shelf line can introduce a warn the Commander
     did not cause. Keep footprints tight — a blueprint is only useful if it FITS on a real deck. */
  const BLUEPRINTS = [
    { id: 'front_desk', grp: 'chain', label: 'FRONT DESK', w: 12, h: 2,
      desc: 'INBOX ▸ BAY ▸ OUTBOX — the whole round trip in one row: work arrives, one agent does it, the result ships.',
      props: [
        { t: 'intake', x: 0, y: 0, w: 2, h: 2 },
        { t: 'bay', x: 5, y: 0, w: 2, h: 2, role: 'GENERALIST' },
        { t: 'outbox', x: 10, y: 0, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 1, d: 'E' }, { x: 3, y: 1, d: 'E' }, { x: 4, y: 1, d: 'E' },
        { x: 7, y: 1, d: 'E' }, { x: 8, y: 1, d: 'E' }, { x: 9, y: 1, d: 'E' },
      ] },
    /* the FRONT DESK with a hard ceiling: the INBOX stamps carrying a line budget ($5/day, $1/message)
       so the line can NEVER spend more than it says on the card — the worry-free first line. */
    { id: 'allowance_desk', grp: 'chain', label: 'ALLOWANCE DESK', w: 12, h: 2,
      desc: 'INBOX ▸ BAY ▸ OUTBOX with a hard budget on the door — this line can never spend more than $5 a day or $1 a message; raise it on the INBOX when you trust it.',
      props: [
        { t: 'intake', x: 0, y: 0, w: 2, h: 2, label: 'ALLOWANCE', limits: { maxUsdPerDay: 5, maxUsdPerMessage: 1 } },
        { t: 'bay', x: 5, y: 0, w: 2, h: 2, role: 'GENERALIST' },
        { t: 'outbox', x: 10, y: 0, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 1, d: 'E' }, { x: 3, y: 1, d: 'E' }, { x: 4, y: 1, d: 'E' },
        { x: 7, y: 1, d: 'E' }, { x: 8, y: 1, d: 'E' }, { x: 9, y: 1, d: 'E' },
      ] },
    /* TWO ENTRIES, ONE DESK: every INBOX is its own named line with its own budget — two doors
       funneled through a MERGER means channel work and routine work share a crew but keep separate
       names, budgets and logbooks. */
    { id: 'two_doors', grp: 'chain', label: 'TWO DOORS', w: 14, h: 6,
      desc: 'two INBOXes ▸ MERGER ▸ BAY ▸ OUTBOX — two entrances share one desk; each door is its own line with its own name and budget.',
      props: [
        { t: 'intake', x: 0, y: 0, w: 2, h: 2 },
        { t: 'intake', x: 0, y: 4, w: 2, h: 2 },
        { t: 'merger', x: 4, y: 3, w: 1, h: 1, block: false },
        { t: 'bay', x: 7, y: 2, w: 2, h: 2, role: 'GENERALIST' },
        { t: 'outbox', x: 12, y: 2, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 1, d: 'E' }, { x: 3, y: 1, d: 'E' }, { x: 4, y: 1, d: 'S' }, { x: 4, y: 2, d: 'S' },
        { x: 2, y: 5, d: 'E' }, { x: 3, y: 5, d: 'E' }, { x: 4, y: 5, d: 'N' }, { x: 4, y: 4, d: 'N' },
        { x: 4, y: 3, d: 'E' }, { x: 5, y: 3, d: 'E' }, { x: 6, y: 3, d: 'E' },
        { x: 9, y: 3, d: 'E' }, { x: 10, y: 3, d: 'E' }, { x: 11, y: 3, d: 'E' },
      ] },
    { id: 'research_line', grp: 'chain', label: 'RESEARCH LINE', w: 17, h: 2,
      desc: 'INBOX ▸ BAY ▸ BAY ▸ OUTBOX — work rides in, two agents work it in turn (a hand-off chain), the result ships out.',
      props: [
        { t: 'intake', x: 0, y: 0, w: 2, h: 2 },
        { t: 'bay', x: 5, y: 0, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'bay', x: 10, y: 0, w: 2, h: 2, role: 'WRITER' },
        { t: 'outbox', x: 15, y: 0, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 1, d: 'E' }, { x: 3, y: 1, d: 'E' }, { x: 4, y: 1, d: 'E' },
        { x: 7, y: 1, d: 'E' }, { x: 8, y: 1, d: 'E' }, { x: 9, y: 1, d: 'E' },
        { x: 12, y: 1, d: 'E' }, { x: 13, y: 1, d: 'E' }, { x: 14, y: 1, d: 'E' },
      ] },
    /* THE LOOP GATE, pre-wired (2026-08-29). The one legal way round: the reviewer's verdict decides,
       the crate re-enters at the DRAFTER on the back lane, and the pass count ends it either way.
       `when: 'approved'` stamps configured because a gate with no verdict word sends EVERY pass back
       until the cap — a line that quietly spends three runs on work the reviewer already passed. */
    { id: 'revision_loop', grp: 'gate', label: 'REVISION LOOP', w: 18, h: 5,
      desc: 'INBOX ▸ DRAFTER ▸ REVIEWER ▸ LOOP GATE — the reviewer sends the draft back round for another pass until the verdict is APPROVED (3 passes max), then it ships.',
      props: [
        { t: 'intake', x: 0, y: 3, w: 2, h: 2 },
        { t: 'bay', x: 4, y: 3, w: 2, h: 2, role: 'WRITER' },
        { t: 'bay', x: 9, y: 3, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'loop', x: 13, y: 4, w: 1, h: 1, block: false, done: 'E', when: 'approved', maxIter: 3 },
        { t: 'outbox', x: 16, y: 3, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 4, d: 'E' }, { x: 3, y: 4, d: 'E' },
        { x: 6, y: 4, d: 'E' }, { x: 7, y: 4, d: 'E' }, { x: 8, y: 4, d: 'E' },
        { x: 11, y: 4, d: 'E' }, { x: 12, y: 4, d: 'E' }, { x: 13, y: 4, d: 'E' },
        { x: 14, y: 4, d: 'E' }, { x: 15, y: 4, d: 'E' },
        // the BACK lane: up out of the gate, west over the top of the line, down into the drafter's ring.
        // The column runs ALL the way to the lane row (3,3) — it already delivered from (3,2), but a
        // column that stops a tile short READS broken, and a line that looks broken is one nobody trusts.
        { x: 13, y: 3, d: 'N' }, { x: 13, y: 2, d: 'N' }, { x: 13, y: 1, d: 'N' }, { x: 13, y: 0, d: 'W' },
        { x: 12, y: 0, d: 'W' }, { x: 11, y: 0, d: 'W' }, { x: 10, y: 0, d: 'W' }, { x: 9, y: 0, d: 'W' },
        { x: 8, y: 0, d: 'W' }, { x: 7, y: 0, d: 'W' }, { x: 6, y: 0, d: 'W' }, { x: 5, y: 0, d: 'W' },
        { x: 4, y: 0, d: 'W' },
        { x: 3, y: 0, d: 'S' }, { x: 3, y: 1, d: 'S' }, { x: 3, y: 2, d: 'S' }, { x: 3, y: 3, d: 'S' },
      ] },
    { id: 'sorting_office', grp: 'sort', label: 'SORTING OFFICE', w: 9, h: 5,
      desc: 'INBOX ▸ FILTER ▸ two BAYs — the filter reads each job and sends code one way, everything else the other.',
      props: [
        { t: 'intake', x: 0, y: 0, w: 2, h: 2 },
        // pre-configured so a fresh stamp never nags FILTER_NO_DEFAULT: code → east lane, everything else → south
        { t: 'filter', x: 4, y: 1, w: 1, h: 1, block: false, routes: { code: 'E' }, def: 'S' },
        { t: 'bay', x: 7, y: 0, w: 2, h: 2, role: 'ENGINEER' },     // the filter's `code -> E` lane lands here
        { t: 'bay', x: 7, y: 3, w: 2, h: 2, role: 'GENERALIST' },   // the default (everything-else) lane
      ],
      belts: [
        { x: 2, y: 1, d: 'E' }, { x: 3, y: 1, d: 'E' }, { x: 4, y: 1, d: 'E' },
        { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' },
        { x: 4, y: 2, d: 'S' }, { x: 4, y: 3, d: 'S' }, { x: 4, y: 4, d: 'E' }, { x: 5, y: 4, d: 'E' }, { x: 6, y: 4, d: 'E' },
      ] },
    /* FULL TRIAGE. The filter's THREE lanes are exactly Classify.getTag's three tags (code /
       research / general) — a routes map naming a tag the classifier never emits would leave a dock
       dark forever. The MERGER funnels the three lanes back into one exit: every crate rides
       straight through (it combines nothing), so ONE outbox serves all three specialists. */
    { id: 'triage_desk', grp: 'sort', label: 'TRIAGE DESK', w: 16, h: 8,
      desc: 'INBOX ▸ FILTER ▸ three BAYs ▸ MERGER ▸ OUTBOX — code, research and everything else each get their own specialist, and every result leaves by the same door.',
      props: [
        { t: 'intake', x: 0, y: 3, w: 2, h: 2 },
        { t: 'filter', x: 5, y: 4, w: 1, h: 1, block: false, routes: { code: 'N', research: 'S' }, def: 'E' },
        { t: 'bay', x: 8, y: 0, w: 2, h: 2, role: 'ENGINEER' },       // the code lane (N)
        { t: 'bay', x: 8, y: 3, w: 2, h: 2, role: 'GENERALIST' },     // the default lane (E)
        { t: 'bay', x: 8, y: 6, w: 2, h: 2, role: 'RESEARCHER' },     // the research lane (S)
        { t: 'merger', x: 11, y: 4, w: 1, h: 1, block: false },
        { t: 'outbox', x: 14, y: 3, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 4, d: 'E' }, { x: 3, y: 4, d: 'E' }, { x: 4, y: 4, d: 'E' }, { x: 5, y: 4, d: 'E' },
        { x: 5, y: 3, d: 'N' }, { x: 5, y: 2, d: 'N' }, { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' }, { x: 7, y: 1, d: 'E' },
        { x: 6, y: 4, d: 'E' }, { x: 7, y: 4, d: 'E' },
        { x: 5, y: 5, d: 'S' }, { x: 5, y: 6, d: 'S' }, { x: 5, y: 7, d: 'E' }, { x: 6, y: 7, d: 'E' }, { x: 7, y: 7, d: 'E' },
        { x: 10, y: 1, d: 'E' }, { x: 11, y: 1, d: 'S' }, { x: 11, y: 2, d: 'S' }, { x: 11, y: 3, d: 'S' },
        { x: 10, y: 4, d: 'E' },
        { x: 10, y: 7, d: 'E' }, { x: 11, y: 7, d: 'N' }, { x: 11, y: 6, d: 'N' }, { x: 11, y: 5, d: 'N' },
        { x: 11, y: 4, d: 'E' }, { x: 12, y: 4, d: 'E' }, { x: 13, y: 4, d: 'E' },
      ] },
    { id: 'parallel_crew', grp: 'crew', label: 'PARALLEL CREW', w: 10, h: 8,
      desc: 'INBOX ▸ SPLITTER ▸ three BAYs — one stream of work spread across three agents working in parallel.',
      props: [
        { t: 'intake', x: 0, y: 3, w: 2, h: 2 },
        { t: 'splitter', x: 4, y: 4, w: 1, h: 1, block: false },
        { t: 'bay', x: 8, y: 0, w: 2, h: 2, role: 'CREW' },
        { t: 'bay', x: 8, y: 3, w: 2, h: 2, role: 'CREW' },
        { t: 'bay', x: 8, y: 6, w: 2, h: 2, role: 'CREW' },
      ],
      belts: [
        { x: 2, y: 4, d: 'E' }, { x: 3, y: 4, d: 'E' }, { x: 4, y: 4, d: 'E' },
        { x: 4, y: 3, d: 'N' }, { x: 4, y: 2, d: 'N' }, { x: 4, y: 1, d: 'E' }, { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' }, { x: 7, y: 1, d: 'E' },
        { x: 5, y: 4, d: 'E' }, { x: 6, y: 4, d: 'E' }, { x: 7, y: 4, d: 'E' },
        { x: 4, y: 5, d: 'S' }, { x: 4, y: 6, d: 'S' }, { x: 4, y: 7, d: 'E' }, { x: 5, y: 7, d: 'E' }, { x: 6, y: 7, d: 'E' }, { x: 7, y: 7, d: 'E' },
      ] },
    /* FAN-OUT ▸ FAN-IN. A SPLITTER whose lanes reach a JOINER compiles as a FAN-OUT (`fanout: true`):
       every branch runs the SAME job, and the joiner is a real barrier — it holds one crate per
       in-lane and releases ONE merged crate. That is the difference from PARALLEL CREW, whose
       joiner-less splitter round-robins one job to one dock. The ANALYST dock past the barrier is
       the stage that turns three partial answers into the one that ships. */
    { id: 'swarm_synthesis', grp: 'crew', label: 'RESEARCH SWARM', w: 20, h: 8,
      desc: 'INBOX ▸ SPLITTER ▸ three BAYs ▸ JOINER ▸ ANALYST ▸ OUTBOX — three agents attack the same job at once, the joiner waits for all three, and one agent writes the answer from what they found.',
      props: [
        { t: 'intake', x: 0, y: 3, w: 2, h: 2 },
        { t: 'splitter', x: 5, y: 4, w: 1, h: 1, block: false },
        { t: 'bay', x: 8, y: 0, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'bay', x: 8, y: 3, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'bay', x: 8, y: 6, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'joiner', x: 11, y: 4, w: 1, h: 1, block: false },
        { t: 'bay', x: 14, y: 3, w: 2, h: 2, role: 'ANALYST' },
        { t: 'outbox', x: 18, y: 3, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 4, d: 'E' }, { x: 3, y: 4, d: 'E' }, { x: 4, y: 4, d: 'E' }, { x: 5, y: 4, d: 'E' },
        { x: 5, y: 3, d: 'N' }, { x: 5, y: 2, d: 'N' }, { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' }, { x: 7, y: 1, d: 'E' },
        { x: 6, y: 4, d: 'E' }, { x: 7, y: 4, d: 'E' },
        { x: 5, y: 5, d: 'S' }, { x: 5, y: 6, d: 'S' }, { x: 5, y: 7, d: 'E' }, { x: 6, y: 7, d: 'E' }, { x: 7, y: 7, d: 'E' },
        { x: 10, y: 1, d: 'E' }, { x: 11, y: 1, d: 'S' }, { x: 11, y: 2, d: 'S' }, { x: 11, y: 3, d: 'S' },
        { x: 10, y: 4, d: 'E' },
        { x: 10, y: 7, d: 'E' }, { x: 11, y: 7, d: 'N' }, { x: 11, y: 6, d: 'N' }, { x: 11, y: 5, d: 'N' },
        { x: 11, y: 4, d: 'E' }, { x: 12, y: 4, d: 'E' }, { x: 13, y: 4, d: 'E' },
        { x: 16, y: 4, d: 'E' }, { x: 17, y: 4, d: 'E' },
      ] },
    { id: 'second_opinion', grp: 'crew', label: 'SECOND OPINION', w: 15, h: 6,
      desc: 'INBOX ▸ SPLITTER ▸ two BAYs ▸ JOINER ▸ OUTBOX — two agents answer the same job independently and the joiner ships both takes as one crate.',
      props: [
        { t: 'intake', x: 0, y: 2, w: 2, h: 2 },
        { t: 'splitter', x: 5, y: 3, w: 1, h: 1, block: false },
        { t: 'bay', x: 7, y: 0, w: 2, h: 2, role: 'CREW' },
        { t: 'bay', x: 7, y: 4, w: 2, h: 2, role: 'CREW' },
        { t: 'joiner', x: 10, y: 3, w: 1, h: 1, block: false },
        { t: 'outbox', x: 13, y: 2, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 3, d: 'E' }, { x: 3, y: 3, d: 'E' }, { x: 4, y: 3, d: 'E' }, { x: 5, y: 3, d: 'N' },
        { x: 5, y: 2, d: 'N' }, { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' },
        { x: 5, y: 4, d: 'S' }, { x: 5, y: 5, d: 'E' }, { x: 6, y: 5, d: 'E' },
        { x: 9, y: 1, d: 'E' }, { x: 10, y: 1, d: 'S' }, { x: 10, y: 2, d: 'S' },
        { x: 9, y: 5, d: 'E' }, { x: 10, y: 5, d: 'N' }, { x: 10, y: 4, d: 'N' },
        { x: 10, y: 3, d: 'E' }, { x: 11, y: 3, d: 'E' }, { x: 12, y: 3, d: 'E' },
      ] },
    /* ROUND-ROBIN WITH A SHIPPING DOOR: no joiner downstream, so the split alternates — each job
       runs on ONE of the two docks (halved queue, not doubled spend) — and both docks' results
       funnel through the MERGER to the same pallet. The high-volume inbox line. */
    { id: 'load_balancer', grp: 'crew', label: 'LOAD BALANCER', w: 15, h: 6,
      desc: 'INBOX ▸ SPLITTER ▸ two BAYs ▸ MERGER ▸ OUTBOX — each job runs on whichever desk is next (turn about, not both), and every result ships by the same door.',
      props: [
        { t: 'intake', x: 0, y: 2, w: 2, h: 2 },
        { t: 'splitter', x: 5, y: 3, w: 1, h: 1, block: false },
        { t: 'bay', x: 7, y: 0, w: 2, h: 2, role: 'CREW' },
        { t: 'bay', x: 7, y: 4, w: 2, h: 2, role: 'CREW' },
        { t: 'merger', x: 10, y: 3, w: 1, h: 1, block: false },
        { t: 'outbox', x: 13, y: 2, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 3, d: 'E' }, { x: 3, y: 3, d: 'E' }, { x: 4, y: 3, d: 'E' }, { x: 5, y: 3, d: 'N' },
        { x: 5, y: 2, d: 'N' }, { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' },
        { x: 5, y: 4, d: 'S' }, { x: 5, y: 5, d: 'E' }, { x: 6, y: 5, d: 'E' },
        { x: 9, y: 1, d: 'E' }, { x: 10, y: 1, d: 'S' }, { x: 10, y: 2, d: 'S' },
        { x: 9, y: 5, d: 'E' }, { x: 10, y: 5, d: 'N' }, { x: 10, y: 4, d: 'N' },
        { x: 10, y: 3, d: 'E' }, { x: 11, y: 3, d: 'E' }, { x: 12, y: 3, d: 'E' },
      ] },
    { id: 'ship_out', grp: 'chain', label: 'SHIP-OUT LOOP', w: 7, h: 2,
      desc: 'BAY ▸ OUTBOX — the smallest line: one agent, and every finished job ships a crate to the pallet.',
      props: [
        { t: 'bay', x: 0, y: 0, w: 2, h: 2, role: 'SHIPPER' },
        { t: 'outbox', x: 5, y: 0, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 1, d: 'E' }, { x: 3, y: 1, d: 'E' }, { x: 4, y: 1, d: 'E' },
      ] },
    /* ---- THE POWER TIER (2026-08-29): multi-mechanic lines for Commanders past the onramp. Same
       contract as every card above (zero-error crewed compile, one undo), they just chain the
       machines the shelf has already taught. */
    { id: 'assembly_line', grp: 'chain', label: 'ASSEMBLY LINE', w: 22, h: 2,
      desc: 'INBOX ▸ four BAYs ▸ OUTBOX — the deep hand-off chain: dig, make sense of it, write it, ship it, each stage building on the last.',
      props: [
        { t: 'intake', x: 0, y: 0, w: 2, h: 2 },
        { t: 'bay', x: 4, y: 0, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'bay', x: 8, y: 0, w: 2, h: 2, role: 'ANALYST' },
        { t: 'bay', x: 12, y: 0, w: 2, h: 2, role: 'WRITER' },
        { t: 'bay', x: 16, y: 0, w: 2, h: 2, role: 'SHIPPER' },
        { t: 'outbox', x: 20, y: 0, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 1, d: 'E' }, { x: 3, y: 1, d: 'E' },
        { x: 6, y: 1, d: 'E' }, { x: 7, y: 1, d: 'E' },
        { x: 10, y: 1, d: 'E' }, { x: 11, y: 1, d: 'E' },
        { x: 14, y: 1, d: 'E' }, { x: 15, y: 1, d: 'E' },
        { x: 18, y: 1, d: 'E' }, { x: 19, y: 1, d: 'E' },
      ] },
    /* FILTER + LOOP on one line: code takes the reviewed lane (engineer's work must pass the
       reviewer's verdict to ship), everything else lands on the generalist. */
    /* the ESCALATION LANE, pre-wired (2026-08-30): the gate's THIRD lane. Approved work ships, a
       failed pass goes back round — and work that runs OUT of passes drops to the FIXER, who does
       what they can with it and ships THAT. Nothing ever leaves the line as a bare apology. */
    { id: 'fire_escape', grp: 'gate', label: 'FIRE ESCAPE', w: 19, h: 8,
      desc: 'INBOX ▸ DRAFTER ▸ REVIEWER ▸ LOOP GATE with THREE lanes — approved ships, revise goes back round, and out-of-passes drops to the FIXER, who salvages it and ships that.',
      props: [
        { t: 'intake', x: 0, y: 3, w: 2, h: 2 },
        { t: 'bay', x: 4, y: 3, w: 2, h: 2, role: 'WRITER' },
        { t: 'bay', x: 9, y: 3, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'loop', x: 13, y: 4, w: 1, h: 1, block: false, done: 'E', esc: 'S', when: 'approved', maxIter: 3 },
        { t: 'outbox', x: 16, y: 3, w: 2, h: 2 },
        { t: 'bay', x: 15, y: 6, w: 2, h: 2, role: 'FIXER' },
      ],
      belts: [
        { x: 2, y: 4, d: 'E' }, { x: 3, y: 4, d: 'E' },
        { x: 6, y: 4, d: 'E' }, { x: 7, y: 4, d: 'E' }, { x: 8, y: 4, d: 'E' },
        { x: 11, y: 4, d: 'E' }, { x: 12, y: 4, d: 'E' }, { x: 13, y: 4, d: 'E' },
        { x: 14, y: 4, d: 'E' }, { x: 15, y: 4, d: 'E' },
        // the BACK lane (full column to the lane row, as always)
        { x: 13, y: 3, d: 'N' }, { x: 13, y: 2, d: 'N' }, { x: 13, y: 1, d: 'N' }, { x: 13, y: 0, d: 'W' },
        { x: 12, y: 0, d: 'W' }, { x: 11, y: 0, d: 'W' }, { x: 10, y: 0, d: 'W' }, { x: 9, y: 0, d: 'W' },
        { x: 8, y: 0, d: 'W' }, { x: 7, y: 0, d: 'W' }, { x: 6, y: 0, d: 'W' }, { x: 5, y: 0, d: 'W' },
        { x: 4, y: 0, d: 'W' },
        { x: 3, y: 0, d: 'S' }, { x: 3, y: 1, d: 'S' }, { x: 3, y: 2, d: 'S' }, { x: 3, y: 3, d: 'S' },
        // the ESCALATION lane: down out of the gate, into the fixer — then the fixer ships too
        { x: 13, y: 5, d: 'S' }, { x: 13, y: 6, d: 'E' }, { x: 14, y: 6, d: 'E' },
        { x: 17, y: 6, d: 'E' }, { x: 18, y: 6, d: 'N' }, { x: 18, y: 5, d: 'N' },
      ] },
    /* BUILD & TEST (2026-09-28, from PR #47 by @mvanhorn): the software loop without CODE FOUNDRY's sorter. The
       TESTER's verdict decides — a failing change goes back up and over into the BUILDER's top edge (the CODE
       FOUNDRY back-lane shape), a passing one ships; the pass count ends it either way. `when: 'approved'` is the
       gate word verdict.js also reads from "VERDICT: pass". The SOFTWARE STUDIO preset stamps this same line. */
    { id: 'build_test', grp: 'gate', label: 'BUILD & TEST', w: 16, h: 4,
      desc: 'INBOX ▸ BUILDER ▸ TESTER ▸ LOOP GATE ▸ OUTBOX — the tester checks the change and sends it back to the builder until it passes (3 passes max), then it ships.',
      props: [
        { t: 'intake', x: 0, y: 2, w: 2, h: 2 },
        { t: 'bay', x: 4, y: 2, w: 2, h: 2, role: 'ENGINEER' },
        { t: 'bay', x: 8, y: 2, w: 2, h: 2, role: 'TESTER' },
        { t: 'loop', x: 12, y: 3, w: 1, h: 1, block: false, done: 'E', when: 'approved', maxIter: 3 },
        { t: 'outbox', x: 14, y: 2, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 3, d: 'E' }, { x: 3, y: 3, d: 'E' },
        { x: 6, y: 3, d: 'E' }, { x: 7, y: 3, d: 'E' },
        { x: 10, y: 3, d: 'E' }, { x: 11, y: 3, d: 'E' }, { x: 12, y: 3, d: 'E' }, { x: 13, y: 3, d: 'E' },
        // the back lane: up out of the gate, west over the tester, down into the builder's top edge
        { x: 12, y: 2, d: 'N' }, { x: 12, y: 1, d: 'N' }, { x: 12, y: 0, d: 'W' },
        { x: 11, y: 0, d: 'W' }, { x: 10, y: 0, d: 'W' }, { x: 9, y: 0, d: 'W' }, { x: 8, y: 0, d: 'W' },
        { x: 7, y: 0, d: 'W' }, { x: 6, y: 0, d: 'W' }, { x: 5, y: 0, d: 'S' }, { x: 5, y: 1, d: 'S' },
      ] },
    { id: 'code_foundry', grp: 'gate', label: 'CODE FOUNDRY', w: 19, h: 7,
      desc: 'INBOX ▸ FILTER ▸ ENGINEER ▸ REVIEWER ▸ LOOP GATE ▸ OUTBOX — code work is built, reviewed, and sent back round until the verdict is APPROVED; everything else takes the generalist lane.',
      props: [
        { t: 'intake', x: 0, y: 2, w: 2, h: 2 },
        { t: 'filter', x: 4, y: 3, w: 1, h: 1, block: false, routes: { code: 'E' }, def: 'S' },
        { t: 'bay', x: 7, y: 2, w: 2, h: 2, role: 'ENGINEER' },
        { t: 'bay', x: 11, y: 2, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'loop', x: 14, y: 3, w: 1, h: 1, block: false, done: 'E', when: 'approved', maxIter: 3 },
        { t: 'outbox', x: 17, y: 2, w: 2, h: 2 },
        { t: 'bay', x: 7, y: 5, w: 2, h: 2, role: 'GENERALIST' },
      ],
      belts: [
        { x: 2, y: 3, d: 'E' }, { x: 3, y: 3, d: 'E' }, { x: 4, y: 3, d: 'E' },
        { x: 5, y: 3, d: 'E' }, { x: 6, y: 3, d: 'E' },
        { x: 9, y: 3, d: 'E' }, { x: 10, y: 3, d: 'E' },
        { x: 13, y: 3, d: 'E' }, { x: 14, y: 3, d: 'E' },
        { x: 15, y: 3, d: 'E' }, { x: 16, y: 3, d: 'E' },
        // the LOOP's back lane: over the reviewer, down into the engineer's ring (full column to the bay)
        { x: 14, y: 2, d: 'N' }, { x: 14, y: 1, d: 'N' }, { x: 14, y: 0, d: 'W' },
        { x: 13, y: 0, d: 'W' }, { x: 12, y: 0, d: 'W' }, { x: 11, y: 0, d: 'W' },
        { x: 10, y: 0, d: 'W' }, { x: 9, y: 0, d: 'W' }, { x: 8, y: 0, d: 'S' },
        { x: 8, y: 1, d: 'S' },
        // the default (everything-else) lane south to the generalist
        { x: 4, y: 4, d: 'S' }, { x: 4, y: 5, d: 'S' }, { x: 4, y: 6, d: 'E' },
        { x: 5, y: 6, d: 'E' }, { x: 6, y: 6, d: 'E' },
      ] },
    /* EVERY MECHANIC ON ONE FLOOR: fan-out ▸ barrier ▸ synthesis ▸ review ▸ verdict-gated loop.
       The gate's back lane re-enters at the ANALYST — a failed review redoes the synthesis from
       the same two takes, never re-runs the crews. */
    { id: 'gauntlet', grp: 'flagship', label: 'THE GAUNTLET', w: 25, h: 6,
      desc: 'INBOX ▸ SPLITTER ▸ two BAYs ▸ JOINER ▸ ANALYST ▸ REVIEWER ▸ LOOP GATE ▸ OUTBOX — two takes, one synthesis, and a reviewer who sends it back until the verdict is APPROVED.',
      props: [
        { t: 'intake', x: 0, y: 2, w: 2, h: 2 },
        { t: 'splitter', x: 5, y: 3, w: 1, h: 1, block: false },
        { t: 'bay', x: 7, y: 0, w: 2, h: 2, role: 'CREW' },
        { t: 'bay', x: 7, y: 4, w: 2, h: 2, role: 'CREW' },
        { t: 'joiner', x: 10, y: 3, w: 1, h: 1, block: false },
        { t: 'bay', x: 13, y: 2, w: 2, h: 2, role: 'ANALYST' },
        { t: 'bay', x: 17, y: 2, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'loop', x: 20, y: 3, w: 1, h: 1, block: false, done: 'E', when: 'approved', maxIter: 3 },
        { t: 'outbox', x: 23, y: 2, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 3, d: 'E' }, { x: 3, y: 3, d: 'E' }, { x: 4, y: 3, d: 'E' }, { x: 5, y: 3, d: 'N' },
        { x: 5, y: 2, d: 'N' }, { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' },
        { x: 5, y: 4, d: 'S' }, { x: 5, y: 5, d: 'E' }, { x: 6, y: 5, d: 'E' },
        { x: 9, y: 1, d: 'E' }, { x: 10, y: 1, d: 'S' }, { x: 10, y: 2, d: 'S' },
        { x: 9, y: 5, d: 'E' }, { x: 10, y: 5, d: 'N' }, { x: 10, y: 4, d: 'N' },
        { x: 10, y: 3, d: 'E' }, { x: 11, y: 3, d: 'E' }, { x: 12, y: 3, d: 'E' },
        { x: 15, y: 3, d: 'E' }, { x: 16, y: 3, d: 'E' },
        { x: 19, y: 3, d: 'E' }, { x: 20, y: 3, d: 'E' },
        { x: 21, y: 3, d: 'E' }, { x: 22, y: 3, d: 'E' },
        // the LOOP's back lane: over the reviewer, down into the analyst (full column to the bay)
        { x: 20, y: 2, d: 'N' }, { x: 20, y: 1, d: 'N' }, { x: 20, y: 0, d: 'W' },
        { x: 19, y: 0, d: 'W' }, { x: 18, y: 0, d: 'W' }, { x: 17, y: 0, d: 'W' },
        { x: 16, y: 0, d: 'W' }, { x: 15, y: 0, d: 'W' },
        { x: 14, y: 0, d: 'S' }, { x: 14, y: 1, d: 'S' },
      ] },
    /* TWO GATES IN SERIES: the draft is reviewed to approval, then the approved draft is POLISHED
       and reviewed again by a second gate. Each gate's back lane re-enters its OWN stage — gate 1
       redrafts, gate 2 re-polishes; a crate never rides backwards past an approval it earned. */
    { id: 'crucible', grp: 'flagship', label: 'THE CRUCIBLE', w: 29, h: 5,
      desc: 'INBOX ▸ DRAFTER ▸ REVIEWER ▸ LOOP ▸ POLISHER ▸ EDITOR ▸ LOOP ▸ OUTBOX — two verdict gates in series: drafted until approved, then polished until approved again.',
      props: [
        { t: 'intake', x: 0, y: 3, w: 2, h: 2 },
        { t: 'bay', x: 4, y: 3, w: 2, h: 2, role: 'WRITER' },
        { t: 'bay', x: 9, y: 3, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'loop', x: 13, y: 4, w: 1, h: 1, block: false, done: 'E', when: 'approved', maxIter: 3 },
        { t: 'bay', x: 16, y: 3, w: 2, h: 2, role: 'SHIPPER' },
        { t: 'bay', x: 20, y: 3, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'loop', x: 24, y: 4, w: 1, h: 1, block: false, done: 'E', when: 'approved', maxIter: 3 },
        { t: 'outbox', x: 27, y: 3, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 4, d: 'E' }, { x: 3, y: 4, d: 'E' },
        { x: 6, y: 4, d: 'E' }, { x: 7, y: 4, d: 'E' }, { x: 8, y: 4, d: 'E' },
        { x: 11, y: 4, d: 'E' }, { x: 12, y: 4, d: 'E' }, { x: 13, y: 4, d: 'E' },
        { x: 14, y: 4, d: 'E' }, { x: 15, y: 4, d: 'E' },
        // gate 1's back lane: over the top, down into the drafter (full column to the lane row)
        { x: 13, y: 3, d: 'N' }, { x: 13, y: 2, d: 'N' }, { x: 13, y: 1, d: 'N' }, { x: 13, y: 0, d: 'W' },
        { x: 12, y: 0, d: 'W' }, { x: 11, y: 0, d: 'W' }, { x: 10, y: 0, d: 'W' }, { x: 9, y: 0, d: 'W' },
        { x: 8, y: 0, d: 'W' }, { x: 7, y: 0, d: 'W' }, { x: 6, y: 0, d: 'W' }, { x: 5, y: 0, d: 'W' },
        { x: 4, y: 0, d: 'W' },
        { x: 3, y: 0, d: 'S' }, { x: 3, y: 1, d: 'S' }, { x: 3, y: 2, d: 'S' }, { x: 3, y: 3, d: 'S' },
        // the approved draft rides on: polisher, editor, gate 2, out
        { x: 18, y: 4, d: 'E' }, { x: 19, y: 4, d: 'E' },
        { x: 22, y: 4, d: 'E' }, { x: 23, y: 4, d: 'E' }, { x: 24, y: 4, d: 'E' },
        { x: 25, y: 4, d: 'E' }, { x: 26, y: 4, d: 'E' },
        // gate 2's back lane: down into the polisher
        { x: 24, y: 3, d: 'N' }, { x: 24, y: 2, d: 'N' }, { x: 24, y: 1, d: 'N' }, { x: 24, y: 0, d: 'W' },
        { x: 23, y: 0, d: 'W' }, { x: 22, y: 0, d: 'W' }, { x: 21, y: 0, d: 'W' }, { x: 20, y: 0, d: 'W' },
        { x: 19, y: 0, d: 'W' }, { x: 18, y: 0, d: 'W' }, { x: 17, y: 0, d: 'W' }, { x: 16, y: 0, d: 'W' },
        { x: 15, y: 0, d: 'S' }, { x: 15, y: 1, d: 'S' }, { x: 15, y: 2, d: 'S' }, { x: 15, y: 3, d: 'S' },
      ] },
    /* TRIAGE WITH DEPTH: each of the filter's three lanes is its own little line — code gets built
       THEN reviewed, research gets dug THEN written up, everything else takes the chief — and every
       lane funnels through one MERGER to one door. */
    { id: 'mission_control', grp: 'flagship', label: 'MISSION CONTROL', w: 20, h: 10,
      desc: 'INBOX ▸ FILTER ▸ three two-stage lanes ▸ MERGER ▸ OUTBOX — code is built then reviewed, research is dug then written, the rest takes the chief; one door ships it all.',
      props: [
        { t: 'intake', x: 0, y: 4, w: 2, h: 2 },
        { t: 'filter', x: 5, y: 5, w: 1, h: 1, block: false, routes: { code: 'N', research: 'S' }, def: 'E' },
        { t: 'bay', x: 8, y: 0, w: 2, h: 2, role: 'ENGINEER' },
        { t: 'bay', x: 12, y: 0, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'bay', x: 8, y: 4, w: 2, h: 2, role: 'GENERALIST' },
        { t: 'bay', x: 8, y: 8, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'bay', x: 12, y: 8, w: 2, h: 2, role: 'WRITER' },
        { t: 'merger', x: 15, y: 5, w: 1, h: 1, block: false },
        { t: 'outbox', x: 18, y: 4, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 5, d: 'E' }, { x: 3, y: 5, d: 'E' }, { x: 4, y: 5, d: 'E' }, { x: 5, y: 5, d: 'E' },
        // the code lane: up, east, build then review, then down into the merger
        { x: 5, y: 4, d: 'N' }, { x: 5, y: 3, d: 'N' }, { x: 5, y: 2, d: 'N' },
        { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' }, { x: 7, y: 1, d: 'E' },
        { x: 10, y: 1, d: 'E' }, { x: 11, y: 1, d: 'E' },
        { x: 14, y: 1, d: 'E' }, { x: 15, y: 1, d: 'S' }, { x: 15, y: 2, d: 'S' }, { x: 15, y: 3, d: 'S' }, { x: 15, y: 4, d: 'S' },
        // the default lane straight through the chief
        { x: 6, y: 5, d: 'E' }, { x: 7, y: 5, d: 'E' },
        { x: 10, y: 5, d: 'E' }, { x: 11, y: 5, d: 'E' }, { x: 12, y: 5, d: 'E' }, { x: 13, y: 5, d: 'E' }, { x: 14, y: 5, d: 'E' },
        // the research lane: down, east, dig then write, then up into the merger
        { x: 5, y: 6, d: 'S' }, { x: 5, y: 7, d: 'S' }, { x: 5, y: 8, d: 'S' },
        { x: 5, y: 9, d: 'E' }, { x: 6, y: 9, d: 'E' }, { x: 7, y: 9, d: 'E' },
        { x: 10, y: 9, d: 'E' }, { x: 11, y: 9, d: 'E' },
        { x: 14, y: 9, d: 'E' }, { x: 15, y: 9, d: 'N' }, { x: 15, y: 8, d: 'N' }, { x: 15, y: 7, d: 'N' }, { x: 15, y: 6, d: 'N' },
        // one funnel, one door
        { x: 15, y: 5, d: 'E' }, { x: 16, y: 5, d: 'E' }, { x: 17, y: 5, d: 'E' },
      ] },
    /* THE WHOLE MACHINE: a three-researcher swarm feeds one analyst, the analyst's synthesis is
       written up, and a verdict gate holds the door — its back lane re-enters at the WRITER, so a
       failed review rewrites the piece from the same research, never re-runs the swarm. */
    { id: 'deep_dive', grp: 'flagship', label: 'THE DEEP DIVE', w: 31, h: 8,
      desc: 'INBOX ▸ SPLITTER ▸ three RESEARCHERs ▸ JOINER ▸ ANALYST ▸ WRITER ▸ REVIEWER ▸ LOOP ▸ OUTBOX — a research swarm, one synthesis, one write-up, and a reviewer holding the door.',
      props: [
        { t: 'intake', x: 0, y: 3, w: 2, h: 2 },
        { t: 'splitter', x: 5, y: 4, w: 1, h: 1, block: false },
        { t: 'bay', x: 8, y: 0, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'bay', x: 8, y: 3, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'bay', x: 8, y: 6, w: 2, h: 2, role: 'RESEARCHER' },
        { t: 'joiner', x: 11, y: 4, w: 1, h: 1, block: false },
        { t: 'bay', x: 14, y: 3, w: 2, h: 2, role: 'ANALYST' },
        { t: 'bay', x: 18, y: 3, w: 2, h: 2, role: 'WRITER' },
        { t: 'bay', x: 22, y: 3, w: 2, h: 2, role: 'REVIEWER' },
        { t: 'loop', x: 26, y: 4, w: 1, h: 1, block: false, done: 'E', when: 'approved', maxIter: 3 },
        { t: 'outbox', x: 29, y: 3, w: 2, h: 2 },
      ],
      belts: [
        { x: 2, y: 4, d: 'E' }, { x: 3, y: 4, d: 'E' }, { x: 4, y: 4, d: 'E' }, { x: 5, y: 4, d: 'E' },
        { x: 5, y: 3, d: 'N' }, { x: 5, y: 2, d: 'N' }, { x: 5, y: 1, d: 'E' }, { x: 6, y: 1, d: 'E' }, { x: 7, y: 1, d: 'E' },
        { x: 6, y: 4, d: 'E' }, { x: 7, y: 4, d: 'E' },
        { x: 5, y: 5, d: 'S' }, { x: 5, y: 6, d: 'S' }, { x: 5, y: 7, d: 'E' }, { x: 6, y: 7, d: 'E' }, { x: 7, y: 7, d: 'E' },
        { x: 10, y: 1, d: 'E' }, { x: 11, y: 1, d: 'S' }, { x: 11, y: 2, d: 'S' }, { x: 11, y: 3, d: 'S' },
        { x: 10, y: 4, d: 'E' },
        { x: 10, y: 7, d: 'E' }, { x: 11, y: 7, d: 'N' }, { x: 11, y: 6, d: 'N' }, { x: 11, y: 5, d: 'N' },
        { x: 11, y: 4, d: 'E' }, { x: 12, y: 4, d: 'E' }, { x: 13, y: 4, d: 'E' },
        { x: 16, y: 4, d: 'E' }, { x: 17, y: 4, d: 'E' },
        { x: 20, y: 4, d: 'E' }, { x: 21, y: 4, d: 'E' },
        { x: 24, y: 4, d: 'E' }, { x: 25, y: 4, d: 'E' }, { x: 26, y: 4, d: 'E' },
        { x: 27, y: 4, d: 'E' }, { x: 28, y: 4, d: 'E' },
        // the gate's back lane: over the reviewer, down into the writer (full column to the lane row)
        { x: 26, y: 3, d: 'N' }, { x: 26, y: 2, d: 'N' }, { x: 26, y: 1, d: 'N' }, { x: 26, y: 0, d: 'W' },
        { x: 25, y: 0, d: 'W' }, { x: 24, y: 0, d: 'W' }, { x: 23, y: 0, d: 'W' }, { x: 22, y: 0, d: 'W' },
        { x: 21, y: 0, d: 'W' }, { x: 20, y: 0, d: 'W' }, { x: 19, y: 0, d: 'W' }, { x: 18, y: 0, d: 'W' },
        { x: 17, y: 0, d: 'S' }, { x: 17, y: 1, d: 'S' }, { x: 17, y: 2, d: 'S' }, { x: 17, y: 3, d: 'S' },
      ] },
  ];
  /* PLAIN NAMES + KIND OF WORK (2026-09-28, moved here 2026-09-29): what each line does in everyday words (the shelf card's
     name; the station name stays as its tag), and the kind of work it is for (the shelf's sections, the same kinds the
     station presets are for). One source for the Lines shelf, the agent's station builder and the tests. */
  const LINE_PLAIN = {
    front_desk: 'One agent', allowance_desk: 'One agent, $5 a day', ship_out: 'Agent work to OUTBOX', two_doors: 'Two ways in',
    revision_loop: 'Draft + review', crucible: 'Two review rounds', fire_escape: 'Review + a fixer',
    build_test: 'Build + test', code_foundry: 'Build + review',
    research_line: 'Research + write', swarm_synthesis: 'Three researchers', deep_dive: 'Deep dive + review', assembly_line: 'Four-step chain',
    sorting_office: 'Sort by type', triage_desk: 'Three specialists', parallel_crew: 'Split across three', load_balancer: 'Take turns', mission_control: 'Full triage',
    second_opinion: 'Second opinion', gauntlet: 'Two takes, reviewed',
  };
  const LINE_WORK = {
    front_desk: 'any', allowance_desk: 'any', ship_out: 'any', two_doors: 'any',
    revision_loop: 'write', crucible: 'write', fire_escape: 'write',
    build_test: 'code', code_foundry: 'code',
    research_line: 'research', swarm_synthesis: 'research', deep_dive: 'research', assembly_line: 'research',
    sorting_office: 'volume', triage_desk: 'volume', parallel_crew: 'volume', load_balancer: 'volume', mission_control: 'volume',
    second_opinion: 'decide', gauntlet: 'decide',
  };
  for (const bp of BLUEPRINTS) { if (LINE_PLAIN[bp.id]) bp.plain = LINE_PLAIN[bp.id]; if (LINE_WORK[bp.id]) bp.work = LINE_WORK[bp.id]; }

  /* ============================================================= */
  function makeStation(doc) {
    doc = doc || freshDoc();
    migrate(doc);
    let seq = 0;
    const subs = [];
    const undoStack = [], redoStack = [];

    /* ---------- LINKS (the conveyor-links plan, phase A, 2026-09-28) ----------
       doc.links = the floor's explicit machine-to-machine connections (Pipeline.deriveLinks), in world tiles. Until the
       link tools land every belt edit is still a tile edit, so the links FOLLOW the belts: a cache re-derived whenever
       what the derivation reads changes (the belts, a belt machine's place or size, a FILTER's routes, a LOOP's exit),
       checked on its identity too (an undo or a load hands in other links — re-derived, never trusted). A derivation
       is ADOPTED only when the plan its links compile to is identical to the ring rule's, so this phase can never move a
       line; null = not adopted (no compiler loaded, or a floor they would not reproduce) and the compiler keeps the ring
       rule, exactly as before links existed. The derivation reads the junction config projectGeometry hands the
       compiler (routes / def / done — not esc, which the projection does not carry), so the two can never disagree. */
    const LINK_MACHINES = { intake: 1, bay: 1, outbox: 1, splitter: 1, filter: 1, merger: 1, joiner: 1, loop: 1 };
    const linkCache = { sig: null, links: undefined };
    function currentLinks() {
      const P = pipelineModule();
      if (!P || typeof P.deriveLinks !== 'function') { doc.links = null; return null; }
      const props = [], geoProps = [], belts = [];
      for (const p of doc.props) {
        if (!LINK_MACHINES[p.t]) continue;
        const o = { id: p.id, t: p.t, x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 };
        if (p.routes) o.routes = p.routes; if (p.def) o.def = p.def; if (p.done) o.done = p.done;
        props.push(o);
        const g = Object.assign({}, o);
        if (p.agentId) g.agentId = p.agentId; if (p.when) g.when = p.when; if (p.maxIter) g.maxIter = p.maxIter; if (p.timeoutMin) g.timeoutMin = p.timeoutMin;
        geoProps.push(g);
      }
      for (const k in doc.belts) { const q = k.split(','); belts.push({ x: +q[0], y: +q[1], dir: doc.belts[k] }); }
      const sig = JSON.stringify([props, belts]);
      if (linkCache.sig === sig && linkCache.links === doc.links) return doc.links;
      let links = null;
      if (Array.isArray(doc.links) && typeof P.reconcileLinks === 'function') {
        // PHASE B: the floor's links are what the Commander built — keep every one the floor still stands behind, drop
        // what an edit broke (its belt stays, loose), and link each loose run that joins two machines
        try { links = P.reconcileLinks({ props, belts, links: doc.links }).links; } catch (e) { links = doc.links; }
      } else try {
        // a floor that never had links (a v1 save, or one this build could not adopt): today's ring rule, written down
        const derived = P.deriveLinks({ props, belts });
        const geo = { props: geoProps, belts };
        if (JSON.stringify(P.compileRoutingPlan(geo)) === JSON.stringify(P.compileRoutingPlan(Object.assign({}, geo, { links: derived })))) links = derived;
      } catch (e) { links = null; }
      doc.links = links;
      linkCache.sig = sig; linkCache.links = links;
      return links;
    }

    const fail = (code, msg) => ({ ok: false, error: code, msg: msg || code });

    /* ---------- read accessors ---------- */
    const rooms = () => doc.order.map(id => doc.rooms[id]);
    const roomById = id => doc.rooms[id] || null;
    const spawnRoomId = () => doc.meta.spawnRoomId;

    function eachRectWorld(ignoreId, fn) {
      for (const id of doc.order) {
        if (id === ignoreId) continue;
        const rm = doc.rooms[id];
        for (const r of rm.rects) fn(id, rm, r);
      }
    }

    /* ---------- roomAt, indexed (2026-08-08 perf pass) ----------
       roomAt is the single most-called query in the model: every prop placement check, every belt
       check, bayObjects (three times over the whole prop list), the blueprint candidate scan, and
       REFIT's per-frame validation layer all bottom out here. The linear form below scanned every
       room × every rect on EVERY call, so a 40-room floor turned each of REFIT's per-frame
       bayObjects() calls into thousands of rect tests.

       The index is a tile -> roomId map with EXACTLY the linear scan's semantics: doc.order is
       walked in order and the FIRST room to claim a tile keeps it, so an overlapping rect resolves
       identically either way. It is built lazily (a floor that is never queried never pays) and
       dropped by BOTH snapshot() and emit() — snapshot() runs immediately before every doc
       mutation, so a read taken mid-mutation rebuilds against the doc as it stands, which is what
       the linear scan did. Nothing else may write doc.rooms/doc.order without going through one of
       those two. */
    let roomIdx = null, propIdx = null, propIdIdx = null;
    function dropRoomIdx() { roomIdx = null; propIdx = null; propIdIdx = null; }
    function roomIndex() {
      if (roomIdx) return roomIdx;
      const m = new Map();
      for (const id of doc.order) {
        const rm = doc.rooms[id];
        if (!rm || !rm.rects) continue;
        for (const r of rm.rects) {
          for (let y = r.y1; y <= r.y2; y++) {
            for (let x = r.x1; x <= r.x2; x++) {
              const k = x + ',' + y;
              if (!m.has(k)) m.set(k, id);   // first room in doc.order wins — same as the scan's early return
            }
          }
        }
      }
      return (roomIdx = m);
    }
    function roomAt(tx, ty) {
      const v = roomIndex().get(Math.floor(tx) + ',' + Math.floor(ty));
      return v === undefined ? null : v;
    }

    /* ---------- props (furniture) ---------- */
    const props = () => doc.props;
    /* PROP INDEXES (2026-08-08 perf pass) — same lifetime and the same two drop points as roomIdx.
       Both are built in doc.props order, so "last entry = topmost" and "first id wins" match the
       array scans they replace EXACTLY; a prop covering a tile is registered on every tile of its
       footprint, which is precisely the rectsHit relation the overlap test asks about. Motivation:
       a blueprint candidate scan is thousands of checkProp calls and each one walked the whole prop
       list, so REFIT's candidate field went quadratic in props. */
    function propIndex() {
      if (propIdx) return propIdx;
      const m = new Map();
      for (const p of doc.props) {
        const w = p.w || 1, h = p.h || 1;
        for (let y = p.y; y < p.y + h; y++) {
          for (let x = p.x; x < p.x + w; x++) {
            const k = x + ',' + y, a = m.get(k);
            if (a) a.push(p); else m.set(k, [p]);
          }
        }
      }
      return (propIdx = m);
    }
    const propsAtTile = (x, y) => propIndex().get(Math.floor(x) + ',' + Math.floor(y)) || null;
    function propIdIndex() {
      if (propIdIdx) return propIdIdx;
      const m = new Map();
      for (const p of doc.props) if (!m.has(p.id)) m.set(p.id, p);   // first wins — same as Array.find
      return (propIdIdx = m);
    }
    const propById = id => propIdIndex().get(id) || null;
    const propFootprint = p => ({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 });
    // topmost prop occupying a tile (last in array = drawn last = on top)
    function propAt(tx, ty) {
      const at = propsAtTile(tx, ty);
      return at ? at[at.length - 1].id : null;
    }

    /* ---------- belts (conveyor) ----------
       A keyed graph "x,y"->dir (E|W|N|S). Belts are walkable floor machinery; boxes ride above
       them (the conveyor runtime lives in conveyor.js — the model only owns topology). */
    const DIRS = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    const beltKey = (x, y) => (x | 0) + ',' + (y | 0);
    const beltAt = (x, y) => doc.belts[beltKey(x, y)] || null;
    const belts = () => Object.keys(doc.belts).map(k => { const p = k.split(','); return { x: +p[0], y: +p[1], dir: doc.belts[k] }; });

    function bounds() {
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      eachRectWorld(null, (id, rm, r) => {
        if (r.x1 < mnx) mnx = r.x1; if (r.y1 < mny) mny = r.y1;
        if (r.x2 > mxx) mxx = r.x2; if (r.y2 > mxy) mxy = r.y2;
      });
      if (mnx === Infinity) { mnx = mny = 0; mxx = mxy = 0; }
      return { minTx: mnx, minTy: mny, maxTx: mxx, maxTy: mxy };
    }

    /* ---------- layered validation (returns {ok} | {ok:false, error, msg}) ---------- */
    function checkRects(rects, kind, ignoreId) {
      const isCor = kind === 'corridor';
      for (const r of rects) {
        const w = rectW(r), h = rectH(r);
        if (isCor) {
          if (Math.min(w, h) < 1) return fail('TOO_SMALL', 'hallway needs width');
          if (Math.max(w, h) < MIN_HALL) return fail('TOO_SHORT', 'hallway too short');
        } else {
          if (w < MIN_ROOM || h < MIN_ROOM) return fail('TOO_SMALL', 'room min ' + MIN_ROOM + '×' + MIN_ROOM);
        }
      }
      // candidate rects must not overlap EACH OTHER (multi-rect / L-shaped footprints)
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++)
        if (rectsHit(rects[i], rects[j])) return fail('OVERLAP', 'self-overlapping footprint');
      // the whole footprint can't sprawl past a sane span — a room placed thousands of tiles
      // away would balloon the bake canvas to gigabytes. Reject early so the ghost tints red.
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      const acc = r => { if (r.x1 < mnx) mnx = r.x1; if (r.y1 < mny) mny = r.y1; if (r.x2 > mxx) mxx = r.x2; if (r.y2 > mxy) mxy = r.y2; };
      eachRectWorld(ignoreId, (id, rm, r) => acc(r));
      for (const r of rects) acc(r);
      if (mxx - mnx + 1 > MAX_SPAN || mxy - mny + 1 > MAX_SPAN) return fail('TOO_FAR', 'too far from the station');
      let hitName = null;
      eachRectWorld(ignoreId, (id, rm, r) => {
        if (hitName) return;
        for (const nr of rects) if (rectsHit(nr, r)) { hitName = rm.name || id; return; }
      });
      if (hitName) return fail('OVERLAP', 'overlaps ' + hitName);
      return { ok: true };
    }

    const canPlaceRoom = (rects, kind, ignoreId) =>
      checkRects((rects || []).map(normRect), kind || 'hab', ignoreId);
    const canPlaceHallway = (rects, ignoreId) =>
      checkRects((rects || []).map(normRect), 'corridor', ignoreId);
    /* ROOM SPOTS (2026-09-29; moved here from Build mode's MAKE ROOM so the agent's station builder uses the same finder):
       every W×H room rect that touches the station orthogonally (so the auto-doors can join it) and passes the same
       room check a drawn room does — right of the station, then below, left, above, each slid along its edge, the one
       nearest that edge's middle first. Pure: it only looks. `limit` caps how many it returns (default all). */
    function roomSpots(W, H, kind, limit) {
      W |= 0; H |= 0;
      if (W < MIN_ROOM || H < MIN_ROOM) return [];
      const b = bounds(), cands = [];
      const midY = (b.minTy + b.maxTy) >> 1, midX = (b.minTx + b.maxTx) >> 1;
      for (let y = b.minTy - H + 1; y <= b.maxTy; y++) cands.push({ x: b.maxTx + 1, y, d: Math.abs(y + (H >> 1) - midY) });
      for (let x = b.minTx - W + 1; x <= b.maxTx; x++) cands.push({ x, y: b.maxTy + 1, d: 1000 + Math.abs(x + (W >> 1) - midX) });
      for (let y = b.minTy - H + 1; y <= b.maxTy; y++) cands.push({ x: b.minTx - W, y, d: 2000 + Math.abs(y + (H >> 1) - midY) });
      for (let x = b.minTx - W + 1; x <= b.maxTx; x++) cands.push({ x, y: b.minTy - H, d: 3000 + Math.abs(x + (W >> 1) - midX) });
      cands.sort((p, q) => p.d - q.d || p.y - q.y || p.x - q.x);
      const touches = (x, y) => {
        for (let yy = y; yy < y + H; yy++) if (roomAt(x - 1, yy) || roomAt(x + W, yy)) return true;
        for (let xx = x; xx < x + W; xx++) if (roomAt(xx, y - 1) || roomAt(xx, y + H)) return true;
        return false;
      };
      const out = [], max = limit > 0 ? limit : Infinity;
      for (const c of cands) {
        if (out.length >= max) break;
        if (!touches(c.x, c.y)) continue;
        const rect = { x1: c.x, y1: c.y, x2: c.x + W - 1, y2: c.y + H - 1 };
        if (canPlaceRoom([rect], kind || 'hab').ok) out.push(rect);
      }
      return out;
    }

    /* ---------- history (snapshot-based — small docs, correct by construction) ---------- */
    // links ride the snapshot exactly as the doc holds them (absent / null / a derivation) so an UNDO restores the doc exactly;
    // a restored derivation is a different array, so the link cache re-checks it against the restored belts on the next read
    const snap = () => clone({ rooms: doc.rooms, order: doc.order, meta: doc.meta, _nid: doc._nid, props: doc.props, belts: doc.belts, edges: doc.edges, links: doc.links });
    // snapshot() runs immediately BEFORE every doc mutation, so dropping the roomAt index here is
    // what keeps a mid-mutation read honest (it rebuilds against the doc as it currently stands).
    function snapshot() { dropRoomIdx(); if (batchDepth) return; undoStack.push(snap()); if (undoStack.length > 120) undoStack.shift(); redoStack.length = 0; }
    /* transact(fn) — ONE undo slot for a compound edit, all-or-nothing (workflow panel "+", 2026-09-22).
       The pre-batch state is snapshotted once; every mutation inside skips its own snapshot (batchDepth);
       a failed (or throwing) batch restores that state and re-emits, so nothing half-done ever stays. */
    let batchDepth = 0;
    function transact(fn) {
      /* A REFUSED batch leaves history exactly as it found it (sweep 2026-10-01): snapshot() clears redo, so a refused
         group move / Ctrl+D after an undo used to kill Ctrl+Y. And a NESTED batch (applyLineLayout inside apply) never
         pushed its own slot, yet popped one on failure — the outer batch's (or the user's previous undo). */
      const nested = batchDepth > 0;
      const inner = nested ? snap() : null;
      const redoKept = nested ? null : redoStack.slice();
      snapshot();
      batchDepth++;
      let r;
      try { r = fn(); } catch (e) { r = fail('THREW', String((e && e.message) || e)); }
      finally { batchDepth--; }
      if (!r || !r.ok) {
        if (nested) restore(inner);
        else { restore(undoStack.pop()); redoStack.length = 0; Array.prototype.push.apply(redoStack, redoKept); }
        emit([], { global: true });
      }
      return r;
    }
    // undo/redo never restores copies of a player-made prop that was deleted since (its art and catalog row are gone)
    const keepRestored = (p) => !(propRules && p && typeof p.t === 'string' && p.t.startsWith('user_')) || !!propRules(p.t);
    function restore(s) { dropRoomIdx(); doc.rooms = s.rooms; doc.order = s.order; doc.meta = s.meta; doc._nid = s._nid; doc.props = (s.props || []).filter(keepRestored); doc.belts = s.belts || {}; doc.edges = s.edges || []; if (s.links === undefined) delete doc.links; else doc.links = Array.isArray(s.links) ? s.links : null; }
    /* `global: true` means THIS EDIT CANNOT BE INVALIDATED BY A RECTANGLE — a listener holding a
       tile-cached render must throw the whole cache away, not just the chunks the rects touch.
       Additive: the field is simply absent on every other mutation, and a listener that ignores it
       behaves exactly as before. The one edit that needs it today is the HULL — see setHull. */
    function emit(dirtyRects, opts) {
      seq++;
      dropRoomIdx();   // the floor just moved — the tile->room index is the derived state that must not survive it
      const patch = { seq, dirtyRects: dirtyRects || [] };
      if (opts && opts.global) patch.global = true;
      // Ordinary prop edits change navigation/routing and the live sprite pass,
      // but not the baked deck, walls or room lights. Airlocks remain full edits.
      if (opts && opts.staticBakeUnchanged) patch.staticBakeUnchanged = true;
      subs.forEach(fn => { try { fn(patch); } catch (e) { /* a listener must never break a mutation */ } });
      return patch;
    }

    /* ---------- mutations ---------- */
    function addRoom(opts) {
      const kind = ROOM_KINDS[opts.kind] ? opts.kind : 'hab';
      const rects = (opts.rects || (opts.rect ? [opts.rect] : [])).map(normRect);
      if (!rects.length) return fail('NO_RECT', 'nothing to place');
      const v = checkRects(rects, kind);
      if (!v.ok) return v;
      snapshot();
      const id = 'r' + (doc._nid++);
      const floorStyle = FLOOR_STYLES[opts.floorStyle] ? opts.floorStyle : ROOM_KINDS[kind].floor;
      // null = "inherit the kind default" — never write the default out, so a room built today
      // and a room built before the material axis existed serialize (and render) identically.
      const floorMat = FLOOR_MATERIALS[opts.floorMat] ? opts.floorMat : null;
      const label = ROOM_KINDS[kind].label;
      doc.rooms[id] = {
        id, kind, name: opts.name || (label + '-' + pad2(doc._nid - 1)),
        rects, floorStyle, floorMat, wallStyle: null, wallMat: null, hullStyle: null, hullMat: null, tier: 0, floorPaint: {}
      };
      doc.order.push(id);
      if (!doc.meta.spawnRoomId && kind !== 'corridor') doc.meta.spawnRoomId = id;
      emit(rects);
      return { ok: true, id };
    }

    const placeHallway = opts => addRoom(Object.assign({}, opts, { kind: 'corridor' }));

    function removeRoom(id) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      // "delete", not "reclaim" — the REFIT tool this message answers is labelled DELETE (build.js)
      if (id === doc.meta.spawnRoomId) return fail('SPAWN_ROOM', 'can’t delete the spawn room');
      snapshot();
      const dirty = rm.rects.slice();
      delete doc.rooms[id];
      doc.order = doc.order.filter(x => x !== id);
      // Remove the deck and its supported contents in one undo snapshot.
      // A straddling prop loses support too; neighboring-room contents stay intact.
      doc.props = doc.props.filter(p => {
        const f = propFootprint(p);
        if (!rm.rects.some(r => rectsHit(f, r))) return true;
        dirty.push(f); return false;
      });
      for (const key of Object.keys(doc.belts)) {
        const [x, y] = key.split(',').map(Number);
        if (rm.rects.some(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2)) delete doc.belts[key];
      }
      emit(dirty);
      return { ok: true };
    }

    /* RESIZE A ROOM (2026-09-30, the agent's REFIT access): one rect for its whole footprint, grown or shrunk where it
       stands. Everything on it must still stand on it — a prop or belt the new edges would leave off the deck refuses the
       whole resize, all-or-nothing — and the new footprint passes the same checks as a new room (size, no overlap, the
       span). Per-tile paint outside it goes. One undo slot. */
    function resizeRoom(id, rect) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const nr = normRect(rect || {});
      const v = checkRects([nr], rm.kind, id);
      if (!v.ok) return v;
      const inOld = (x, y) => rm.rects.some(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);
      const inNew = (x, y) => x >= nr.x1 && x <= nr.x2 && y >= nr.y1 && y <= nr.y2;
      for (const p of doc.props) {
        const fp = propFootprint(p);
        for (let y = fp.y1; y <= fp.y2; y++) for (let x = fp.x1; x <= fp.x2; x++)
          if (inOld(x, y) && !inNew(x, y)) return fail('CUTS_CONTENTS', 'a ' + p.t + ' would be left off the deck');
      }
      for (const k of Object.keys(doc.belts)) { const q = k.split(','), x = +q[0], y = +q[1]; if (inOld(x, y) && !inNew(x, y)) return fail('CUTS_CONTENTS', 'a belt would be left off the deck'); }
      // a piece hung on a wall keeps its wall: growing a room over the wall above it left it hanging in mid-floor
      for (const p of doc.props) {
        if (ruleOf(p.t).mount !== 'wall') continue;
        const fp = propFootprint(p);
        for (let x = fp.x1; x <= fp.x2; x++) {
          const y = fp.y1 - 1, other = roomAt(x, y);
          if (!other && inNew(x, y)) return fail('LOSES_WALL', 'a ' + p.t + ' hangs on the wall there: it would be left in mid-floor — move it first');
        }
      }
      snapshot();
      const before = rm.rects.slice();
      rm.rects = [nr];
      if (rm.floorPaint) for (const k of Object.keys(rm.floorPaint)) { const q = k.split(','); if (!inNew(+q[0], +q[1])) delete rm.floorPaint[k]; }
      emit(before.concat([nr]));
      return { ok: true };
    }
    // a room's TYPE (the TYPE palette's kind: HAB, BRIDGE, LAB, FOUNDRY, QUARTERS, STORAGE) after it is built; never to or from a corridor
    function setRoomKind(id, kind) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!ROOM_KINDS[kind] || kind === 'corridor' || rm.kind === 'corridor') return fail('BAD_KIND', 'unknown room type');
      if (rm.kind === kind) return { ok: true };
      snapshot();
      rm.kind = kind;
      emit(rm.rects.slice());
      return { ok: true };
    }

    function moveRoom(id, dTx, dTy) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!dTx && !dTy) return { ok: true };
      const moved = rm.rects.map(r => ({ x1: r.x1 + dTx, y1: r.y1 + dTy, x2: r.x2 + dTx, y2: r.y2 + dTy }));
      const v = checkRects(moved, rm.kind, id);
      if (!v.ok) return v;
      /* the room carries its contents: every prop standing WHOLLY on this room's tiles rides the
         move, and so does every belt tile on them (pipeline edges are prop-id based, so a wired
         line survives untouched). A machine straddling the join with a neighbour belongs to
         neither room — it stays. The landing needs one extra guard: rooms can't overlap, so the
         only stationary props/belts the destination can contain are straddlers reaching into the
         old∩new overlap of a short move. A rider that would land on one vetoes the whole move —
         all-or-nothing, one undo slot, same shape as placeBeltRun. */
      const inRoom = (x, y) => { for (const r of rm.rects) if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) return true; return false; };
      const wholly = f => { for (let y = f.y1; y <= f.y2; y++) for (let x = f.x1; x <= f.x2; x++) if (!inRoom(x, y)) return false; return true; };
      const riders = doc.props.filter(p => wholly(propFootprint(p)));
      const riding = new Set(riders.map(p => p.id));
      const hits = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
      const stayers = doc.props.filter(p => !riding.has(p.id));
      for (const p of riders) {
        const f = propFootprint(p);
        const nf = { x1: f.x1 + dTx, y1: f.y1 + dTy, x2: f.x2 + dTx, y2: f.y2 + dTy };
        for (const q of stayers) if (hits(nf, propFootprint(q))) return fail('OVERLAP', 'a machine straddling the edge is in the way');
      }
      const beltRiders = Object.keys(doc.belts).filter(k => { const p = k.split(','); return inRoom(+p[0], +p[1]); });
      for (const k of beltRiders) {
        const p = k.split(','), t = { x1: +p[0] + dTx, y1: +p[1] + dTy, x2: +p[0] + dTx, y2: +p[1] + dTy };
        for (const q of stayers) if (q.block !== false && hits(t, propFootprint(q))) return fail('OVERLAP', 'a machine straddling the edge is in the way');
      }
      snapshot();
      const before = rm.rects.slice();
      rm.rects = moved;
      if (rm.floorPaint && Object.keys(rm.floorPaint).length) {
        const np = {};
        for (const k in rm.floorPaint) { const p = k.split(',').map(Number); np[(p[0] + dTx) + ',' + (p[1] + dTy)] = rm.floorPaint[k]; }
        rm.floorPaint = np;
      }
      for (const p of riders) { p.x += dTx; p.y += dTy; }
      if (beltRiders.length) {
        const ride = new Set(beltRiders), nb = {};
        for (const k in doc.belts) {
          if (!ride.has(k)) { nb[k] = doc.belts[k]; continue; }
          const p = k.split(',');
          nb[beltKey(+p[0] + dTx, +p[1] + dTy)] = doc.belts[k];
        }
        doc.belts = nb;
      }
      emit(before.concat(moved));
      return { ok: true };
    }

    /* MOVE SEVERAL ROOMS AT ONCE (the lead builder's re-lay, 2026-10-02): each room carries its contents exactly as moveRoom
       does (every prop wholly on it, every belt tile on it, its floor paint), but only the FINAL arrangement is checked:
       rooms passing each other on the way, or a station briefly wider than the span while half its rooms have moved, never
       block a re-lay whose result is sound. Checked before anything changes, then applied as one undo slot. */
    function moveRooms(moves) {
      const list = (Array.isArray(moves) ? moves : []).filter(m => m && doc.rooms[m.id] && (Math.round(+m.dx || 0) || Math.round(+m.dy || 0)));
      if (!list.length) return { ok: true, moved: 0 };
      if (new Set(list.map(m => m.id)).size !== list.length) return fail('BAD_MOVE', 'a room is moved twice');
      const plans = list.map(m => {
        const rm = doc.rooms[m.id], dx = Math.round(+m.dx || 0), dy = Math.round(+m.dy || 0);
        const inRoom = (x, y) => rm.rects.some(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);
        const wholly = f => { for (let y = f.y1; y <= f.y2; y++) for (let x = f.x1; x <= f.x2; x++) if (!inRoom(x, y)) return false; return true; };
        return { rm, dx, dy, rects: rm.rects.map(r => ({ x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy })),
          riders: doc.props.filter(p => wholly(propFootprint(p))), belts: Object.keys(doc.belts).filter(k => { const p = k.split(','); return inRoom(+p[0], +p[1]); }) };
      });
      const hits = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
      // a piece across an open join (a bench straddling two flush rooms) rides when every tile of it is in rooms moving by
      // the same step
      const rode = new Set(); for (const pl of plans) for (const p of pl.riders) rode.add(p.id);
      for (const p of doc.props) {
        if (rode.has(p.id)) continue;
        const f = propFootprint(p); let step = null, ok = true;
        for (let y = f.y1; y <= f.y2 && ok; y++) for (let x = f.x1; x <= f.x2 && ok; x++) {
          const pl = plans.find(q => q.rm.rects.some(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2));
          if (!pl || (step && (step.dx !== pl.dx || step.dy !== pl.dy))) ok = false; else if (!step) step = pl;
        }
        if (ok && step) { step.riders.push(p); rode.add(p.id); }
      }
      const finalOf = new Map(plans.map(pl => [pl.rm.id, pl.rects]));
      const all = Object.keys(doc.rooms).map(id => ({ id, rm: doc.rooms[id], rects: finalOf.get(id) || doc.rooms[id].rects }));
      // the span of the station as it will stand
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const z of all) for (const r of z.rects) { mnx = Math.min(mnx, r.x1); mny = Math.min(mny, r.y1); mxx = Math.max(mxx, r.x2); mxy = Math.max(mxy, r.y2); }
      if (mxx - mnx + 1 > MAX_SPAN || mxy - mny + 1 > MAX_SPAN) return fail('TOO_FAR', 'too far from the station');
      // no moved room lands on another room (moved or not)
      for (const pl of plans) for (const z of all) if (z.id !== pl.rm.id && pl.rects.some(r => z.rects.some(q => hits(r, q)))) return fail('OVERLAP', (pl.rm.name || pl.rm.id) + ' would overlap ' + (z.rm.name || z.id));
      // nothing that stays (a piece or a belt riding no moved room) is left inside a moved room's new floor
      const riding = new Set(), beltOf = new Map();
      for (const pl of plans) { for (const p of pl.riders) riding.add(p.id); for (const k of pl.belts) beltOf.set(k, pl); }
      for (const pl of plans) {
        for (const p of doc.props) if (!riding.has(p.id) && pl.rects.some(r => hits(r, propFootprint(p)))) return fail('OVERLAP', 'a piece at (' + p.x + ', ' + p.y + ') is in the way of ' + (pl.rm.name || pl.rm.id));
        for (const k in doc.belts) { if (beltOf.has(k)) continue; const p = k.split(','), t = { x1: +p[0], y1: +p[1], x2: +p[0], y2: +p[1] }; if (pl.rects.some(r => hits(r, t))) return fail('OVERLAP', 'a belt at (' + p[0] + ', ' + p[1] + ') is in the way of ' + (pl.rm.name || pl.rm.id)); }
      }
      snapshot();
      const dirty = [];
      for (const pl of plans) {
        dirty.push(...pl.rm.rects, ...pl.rects);
        pl.rm.rects = pl.rects;
        if (pl.rm.floorPaint && Object.keys(pl.rm.floorPaint).length) {
          const np = {};
          for (const k in pl.rm.floorPaint) { const p = k.split(',').map(Number); np[(p[0] + pl.dx) + ',' + (p[1] + pl.dy)] = pl.rm.floorPaint[k]; }
          pl.rm.floorPaint = np;
        }
        for (const p of pl.riders) { p.x += pl.dx; p.y += pl.dy; }
      }
      if (beltOf.size) {
        const nb = {};
        for (const k in doc.belts) { const pl = beltOf.get(k); if (!pl) { nb[k] = doc.belts[k]; continue; } const p = k.split(','); nb[beltKey(+p[0] + pl.dx, +p[1] + pl.dy)] = doc.belts[k]; }
        doc.belts = nb;
      }
      emit(dirty);
      return { ok: true, moved: plans.length };
    }

    function setFloor(id, styleId) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!FLOOR_STYLES[styleId]) return fail('BAD_STYLE', 'unknown floor');
      if (rm.floorStyle === styleId && !Object.keys(rm.floorPaint || {}).length) return { ok: true };
      snapshot();
      rm.floorStyle = styleId;
      rm.floorPaint = {};   // a whole-room repaint clears per-tile overrides
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* the MATERIAL axis. Picking the room-kind's own default normalizes back to null so the
       serialized doc never carries a redundant value (and an old save round-trips unchanged). */
    function setMaterial(id, matId) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!FLOOR_MATERIALS[matId]) return fail('BAD_MAT', 'unknown deck material');
      const kindMat = (ROOM_KINDS[rm.kind] && ROOM_KINDS[rm.kind].mat) || 'plate';
      const next = matId === kindMat ? null : matId;
      if ((rm.floorMat || null) === next) return { ok: true };   // no-op: don't burn an undo slot
      snapshot();
      rm.floorMat = next;
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* lay a whole deck — hue AND material — in ONE undo slot. This is what the REFIT SURFACE tool
       commits on a room click, so "undo" reverses the deck the Commander saw laid, not half of it.
       Either field may be omitted to leave that axis alone. */
    function setDeck(id, opts) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const o = opts || {};
      const styleId = o.style == null ? null : o.style;
      const matId = o.mat == null ? null : o.mat;
      if (styleId != null && !FLOOR_STYLES[styleId]) return fail('BAD_STYLE', 'unknown floor');
      if (matId != null && !FLOOR_MATERIALS[matId]) return fail('BAD_MAT', 'unknown deck material');
      const kindMat = (ROOM_KINDS[rm.kind] && ROOM_KINDS[rm.kind].mat) || 'plate';
      const nextMat = matId == null ? (rm.floorMat || null) : (matId === kindMat ? null : matId);
      // a whole-room repaint also clears per-tile overrides, so having any is itself a change
      const styleChanges = styleId != null && (rm.floorStyle !== styleId || !!Object.keys(rm.floorPaint || {}).length);
      const matChanges = (rm.floorMat || null) !== nextMat;
      if (!styleChanges && !matChanges) return { ok: true };
      snapshot();
      if (styleId != null) { rm.floorStyle = styleId; rm.floorPaint = {}; }
      rm.floorMat = nextMat;
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* WALLS — the deck's opposite number, same shape: hue AND material in ONE undo slot. A null
       style means "follow the floor hue", so clearing back to the default is expressible
       (`{style: null}` is "leave alone"; pass `{style: 'follow'}` to reset it). */
    function setWalls(id, opts) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const o = opts || {};
      const wantStyle = o.style === 'follow' ? null : (o.style == null ? undefined : o.style);
      const wantMat = o.mat == null ? undefined : o.mat;
      if (wantStyle !== undefined && wantStyle !== null && !FLOOR_STYLES[wantStyle]) return fail('BAD_STYLE', 'unknown wall colour');
      if (wantMat !== undefined && !WALL_MATERIALS[wantMat]) return fail('BAD_MAT', 'unknown wall material');
      // picking the room's own floor hue IS "follow" — normalize so it never serializes redundantly
      const nextStyle = wantStyle === undefined ? (rm.wallStyle || null)
        : (wantStyle === rm.floorStyle ? null : wantStyle);
      const nextMat = wantMat === undefined ? (rm.wallMat || null) : (wantMat === 'plating' ? null : wantMat);
      if ((rm.wallStyle || null) === nextStyle && (rm.wallMat || null) === nextMat) return { ok: true };
      snapshot();
      rm.wallStyle = nextStyle;
      rm.wallMat = nextMat;
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* HULL — the exterior shell, third axis, same shape as setWalls: hue AND material in ONE undo
       slot. `{style: 'follow'}` clears back to the material's own default tone; `{style: null}` (or
       omitting it) leaves that axis alone. Picking `station` normalizes the material back to null so
       a doc that was never re-clad serializes exactly as it did before this axis existed. */
    function setHull(id, opts) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const o = opts || {};
      const wantStyle = o.style === 'follow' ? null : (o.style == null ? undefined : o.style);
      const wantMat = o.mat == null ? undefined : o.mat;
      if (wantStyle !== undefined && wantStyle !== null && !FLOOR_STYLES[wantStyle]) return fail('BAD_STYLE', 'unknown hull colour');
      if (wantMat !== undefined && !HULL_MATERIALS[wantMat]) return fail('BAD_MAT', 'unknown hull material');
      const nextMat = wantMat === undefined ? (rm.hullMat || null) : (wantMat === 'station' ? null : wantMat);
      // picking the material's OWN suggested hue IS "follow" — normalize so it never serializes
      // redundantly (and so a later catalog re-tune reaches rooms that never chose a tone).
      const suggested = (HULL_MATERIALS[nextMat || 'station'] || {}).suggest || null;
      const nextStyle = wantStyle === undefined ? (rm.hullStyle || null)
        : (wantStyle === suggested ? null : wantStyle);
      if ((rm.hullStyle || null) === nextStyle && (rm.hullMat || null) === nextMat) return { ok: true };
      snapshot();
      rm.hullStyle = nextStyle;
      rm.hullMat = nextMat;
      /* ⛔ THE SHELL IS A STATION-WIDE COMPOSITE, SO ITS INVALIDATION CANNOT BE A RECTANGLE.
         The bake groups footprints by SKIN and resolves every skirt pixel to the nearest footprint
         above it — both station-global. Re-cladding ONE room therefore changes which group its
         neighbours belong to and can change what their skirts look like anywhere on the map.
         Emitting only this room's rects let REFIT (which caches the bake in CHUNKS) re-bake the
         chunks near the edit and keep every other chunk from the PREVIOUS grouping — so earlier
         re-clads came back unrendered or wearing the shell they used to have, and it got worse the
         more rooms you clad (Andrew, 2026-08-06: "the more u add, the more likely the chance one of
         the previous ones will result unrendered, or appear as the old textures"). */
      emit(rm.rects.slice(), { global: true });
      return { ok: true };
    }

    function paintTiles(id, tiles, styleId) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!FLOOR_STYLES[styleId]) return fail('BAD_STYLE', 'unknown floor');
      rm.floorPaint = rm.floorPaint || {};
      const writes = [];
      for (const t of tiles) {
        const k = t[0] + ',' + t[1];
        if (roomAt(t[0], t[1]) === id && rm.floorPaint[k] !== styleId) writes.push(k);
      }
      if (!writes.length) return { ok: true };   // a no-op must not consume an undo slot
      snapshot();
      for (const k of writes) rm.floorPaint[k] = styleId;
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* ---------- prop validation + mutations ----------
       The model stays pure: it doesn't know the prop CATALOG (that lives in propsprites.js).
       The caller supplies w,h (the footprint) from the catalog; the model only validates
       GEOMETRY — every footprint tile must sit on station floor (inside a zone), the footprint
       must not overlap another prop, and the type tag must be a non-empty string.

       MOUNT RULES (2026-07-26) are the one exception, and they are injected rather than imported so
       the layering holds: setPropRules() hands the model a lookup from prop type to
       {mount, stack, surface}. With no lookup installed (plain node tests, older callers) nothing
       changes and every prop is placeable on bare deck exactly as before.

       The mount axis has THREE states, and a prop's catalog row picks one:
         mount 'surface' — REQUIRES a table. The footprint must lie wholly on ONE prop whose catalog
                           row says surface:true, and that host is exempt from the overlap check,
                           because standing on a table is the entire point.
         stack:true      — MAY use a table. Same host rule when one is found; otherwise it places on
                           bare deck like any other prop. (2026-07-29: without this state the only
                           two props in the whole catalog that could go on a table were the two that
                           were FORCED to, so every other small object — a mug, a plant, a stack of
                           printouts — was rejected with OVERLAP the moment a table was under it.
                           A required-mount flag cannot express "a plant belongs on the floor OR on
                           a table", and forcing plant/coffee onto tables would have broken the
                           agents that place their own decor on open deck.)
         neither         — deck only; a table is an obstacle like any other prop.

       A FOURTH, orthogonal axis: flat:true (a floor DECAL — rug / cable run / hazard pad). It is not a
       mount state (a decal hosts nothing; it has no top surface, it IS the deck), it is an exemption
       from the overlap test in both directions — see checkProp.

       mount:'wall' is BACK (2026-08-17, Andrew: "we need to allow mountable wall props") — but it is
       NOT what was reverted. The first version LIFTED the prop onto the tall face the bake raises
       along a room's north edge (a WALL_RISE), and that lifted look is what he rejected on sight;
       every wall-only prop went with it. This version is the CONSTRAINT ONLY: the prop must be
       placed against a north wall and it draws exactly where it always did, hanging in its own tile
       with its own standoff shadow. Nothing lifts, so there is nothing to reject twice. */
    const ruleOf = (t) => (propRules && t) ? (propRules(t) || {}) : {};
    // the single surface prop wholly covering `foot`, or null
    /* A host must WHOLLY contain `foot`, so it necessarily covers foot's top-left tile — the index
       list for that one tile is therefore a superset of every possible host, and walking it topmost-
       first picks the same prop the full reverse scan did (the restricted walk is a subsequence of
       the full one, and both take the first match). */
    function surfaceHostFor(foot, ignoreId) {
      const at = propsAtTile(foot.x1, foot.y1);
      if (!at) return null;
      for (let i = at.length - 1; i >= 0; i--) {
        const p = at[i];
        if (p.id === ignoreId) continue;
        if (!ruleOf(p.t).surface) continue;
        const f = propFootprint(p);
        if (foot.x1 >= f.x1 && foot.x2 <= f.x2 && foot.y1 >= f.y1 && foot.y2 <= f.y2) return p;
      }
      return null;
    }
    function checkProp(foot, ignoreId, type, ignoreSet) {
      if (foot.x2 < foot.x1 || foot.y2 < foot.y1) return fail('NO_RECT', 'nothing to place');
      for (let y = foot.y1; y <= foot.y2; y++) for (let x = foot.x1; x <= foot.x2; x++) {
        if (!roomAt(x, y)) return fail('OFF_DECK', 'must sit on a deck');
      }
      const rule = ruleOf(type);
      let host = null;
      /* WALL MOUNT — every footprint tile must have a WALL immediately north of it. North is the only
         wall this camera can show: south walls are behind the viewer and the east/west ones are seen
         edge-on, so hanging a board on either would be drawing a face that is not there. "A wall" is
         simply the absence of deck — the bake raises its face from exactly that boundary. */
      if (rule.mount === 'wall') {
        for (let x = foot.x1; x <= foot.x2; x++) {
          if (roomAt(x, foot.y1 - 1)) return fail('NEEDS_WALL', 'must hang on a wall — put it against the top edge of a room');
        }
      }
      if (rule.mount === 'surface') {
        host = surfaceHostFor(foot, ignoreId);
        if (!host) return fail('NEEDS_SURFACE', 'must stand on a table');
      } else if (rule.stack) {
        host = surfaceHostFor(foot, ignoreId);   // optional: on a table if there is one, else plain deck
      }
      // FLOOR DECALS (`flat` — rug / cable run / hazard pad) are deck PAINT, not furniture: zero rise,
      // walkable, and transparent to the overlap test in BOTH directions. A decal being placed skips the
      // test entirely (a rug may be unrolled UNDER props that are already standing there), and a decal
      // already on the deck is never an obstacle to anything placed on top of it. Before this a 4×3 rug
      // was a 12-tile exclusion zone you could not put a single lamp on.
      // two integer rects hit iff they share a tile, so only the props REGISTERED on foot's tiles can
      // collide — the index turns this from a walk of the whole prop list into a walk of the footprint
      if (!rule.flat) {
        for (let y = foot.y1; y <= foot.y2; y++) {
          for (let x = foot.x1; x <= foot.x2; x++) {
            const at = propsAtTile(x, y);
            if (!at) continue;
            for (const p of at) {
              if (p.id === ignoreId || (ignoreSet && ignoreSet.has(p.id))) continue;
              if (host && p.id === host.id) continue;         // its own table is not an obstacle
              if (ruleOf(p.t).flat) continue;                 // standing ON a rug is the point of a rug
              return fail('OVERLAP', 'overlaps a prop');
            }
          }
        }
      }
      return { ok: true, host: host ? host.id : null };
    }
    const canPlaceProp = (t, x, y, w, h, ignoreId) =>
      checkProp({ x1: x, y1: y, x2: x + (w || 1) - 1, y2: y + (h || 1) - 1 }, ignoreId, t);

    function addProp(opts) {
      const t = String(opts.t || '').trim();
      if (!t) return fail('NO_TYPE', 'no prop type');
      const w = Math.max(1, opts.w | 0 || 1), h = Math.max(1, opts.h | 0 || 1);
      const x = opts.x | 0, y = opts.y | 0;
      const v = checkProp({ x1: x, y1: y, x2: x + w - 1, y2: y + h - 1 }, null, t);
      if (!v.ok) return v;
      snapshot();
      const id = 'p' + (doc._nid++);
      // block defaults true; the caller (builder) passes the catalog's blocks flag. Wall murals /
      // floor rugs pass block:false so agents walk over/along them (they're flat decor, not obstacles).
      const prop = { id, t, x, y, w, h };
      if (opts.block === false) prop.block = false;
      if (typeof opts.agentId === 'string' && opts.agentId) prop.agentId = opts.agentId;   // a BAY binds a belt endpoint to an agent
      const r0 = cleanRot(opts.r); if (r0) prop.r = r0;    // orientation: omitted when facing south (the default)
      if (opts.m) prop.m = 1;                              // mirrored handedness
      applyJunctionCfg(prop, opts);   // a FILTER/MERGER carries its routes/def/bufferSize (inert on other props)
      if (cleanDoor(opts.door)) prop.door = opts.door;   // an AIRLOCK carries its seal state (inert on other props)
      doc.props.push(prop);
      emit([{ x1: x, y1: y, x2: x + w - 1, y2: y + h - 1 }], { staticBakeUnchanged: t !== 'airlock' });
      return { ok: true, id };
    }

    /* turn a PLACED prop a quarter turn (default clockwise). Whether a turn RESIZES the prop is the
       renderer's knowledge, not the model's — a floor decal and a table genuinely re-tile (their
       footprint IS their picture), while an upright cabinet keeps its box (its second tile is
       vertical drawing room, not depth). So the caller passes the effective box it wants; omitted,
       the footprint is left alone. A turn that re-tiles can genuinely FAIL — turning a 3x1 table
       with a wall one tile north of it has nowhere to go — and the caller shows that reason rather
       than silently clipping. Snapshot-based like every other mutation, so UNDO restores the facing. */
    function rotateProp(id, turns, box) {
      const p = propById(id);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const t = cleanRot(turns == null ? 1 : turns);
      if (!t) return { ok: true };                       // a full turn is a no-op: don't burn an undo slot
      const nw = Math.max(1, (box && box.w | 0) || p.w), nh = Math.max(1, (box && box.h | 0) || p.h);
      if (nw !== p.w || nh !== p.h) {
        const v = checkProp({ x1: p.x, y1: p.y, x2: p.x + nw - 1, y2: p.y + nh - 1 }, id, p.t);
        if (!v.ok) return v;
      }
      snapshot();
      const before = propFootprint(p);
      const nr = cleanRot((p.r | 0) + t);
      p.w = nw; p.h = nh;
      if (nr) p.r = nr; else delete p.r;                 // back to south = back to the default shape on disk
      emit([before, propFootprint(p)], { staticBakeUnchanged: p.t !== 'airlock' });
      return { ok: true, r: nr };
    }

    /* set a PLACED prop's facing outright (the builder walks the prop's OWN honest facing list, so it
       computes the next facing and hands it here rather than blind-adding 1). */
    function faceProp(id, r, box) {
      const p = propById(id);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      return rotateProp(id, cleanRot(cleanRot(r) - (p.r | 0)), box);
    }

    /* flip a PLACED prop's handedness. Never changes the footprint, so unlike a turn it cannot fail. */
    function mirrorProp(id) {
      const p = propById(id);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      snapshot();
      if (p.m) delete p.m; else p.m = 1;
      emit([propFootprint(p)], { staticBakeUnchanged: p.t !== 'airlock' });
      return { ok: true, m: p.m ? 1 : 0 };
    }

    function removeProp(id) {
      const i = doc.props.findIndex(p => p.id === id);
      if (i < 0) return fail('NOT_FOUND', 'no such prop');
      snapshot();
      const p = doc.props[i];
      doc.props.splice(i, 1);
      emit([propFootprint(p)], { staticBakeUnchanged: p.t !== 'airlock' });
      return { ok: true };
    }

    function moveProp(id, dTx, dTy) {
      const p = propById(id);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (!dTx && !dTy) return { ok: true };
      const nx = p.x + dTx, ny = p.y + dTy;
      const v = checkProp({ x1: nx, y1: ny, x2: nx + p.w - 1, y2: ny + p.h - 1 }, id, p.t);
      if (!v.ok) return v;
      const linked = CONNECTABLE[p.t] && Array.isArray(currentLinks());
      snapshot();
      const before = propFootprint(p);
      if (!linked) {
        p.x = nx; p.y = ny;
        emit([before, propFootprint(p)], { staticBakeUnchanged: p.t !== 'airlock' });
        return { ok: true };
      }
      // A LINKED MACHINE'S BELTS FOLLOW IT (conveyor-links phase B): each link to another machine is lifted and re-laid
      // from its new spot, keeping its id and ports; one that finds no route is reported, never silently kept
      const r = relayLinksOf(p, () => { p.x = nx; p.y = ny; });
      emit([before, propFootprint(p)].concat(r.dirty), { staticBakeUnchanged: true });
      return { ok: true, relaid: r.relaid, lost: r.lost };
    }
    /* MOVE SEVERAL PIECES AS ONE (Build Mode's group move, sweep 2026-10-02): every member shifts by (dTx, dTy) at once, then
       each is checked against the floor where it lands, and the belt links of every member are lifted first and re-laid once,
       after ALL have moved. Members never block each other: the group moves rigidly, so what overlapped before (a lamp on its
       table) overlaps the same way after. Member by member, a table was refused by its own lamp, and a link re-laid against a
       neighbour that had not moved yet was lost, depending on the order. One undo; refused, nothing changes. */
    function moveProps(ids, dTx, dTy) {
      const ps = Array.from(new Set(ids || [])).map(propById).filter(Boolean);
      if (!ps.length) return fail('NOT_FOUND', 'no such prop');
      if (!dTx && !dTy) return { ok: true };
      return transact(() => {
        const set = new Set(ps.map(q => q.id)), dirty = ps.map(propFootprint);
        const L = Array.isArray(doc.links) ? doc.links : [];
        const mine = L.filter(l => l && l.from && l.to && l.from.prop != null && l.to.prop != null && l.from.prop !== l.to.prop && (set.has(l.from.prop) || set.has(l.to.prop)));
        const others = L.filter(l => mine.indexOf(l) < 0), keepTile = new Set(), cell = (x, y) => ({ x1: x, y1: y, x2: x, y2: y });
        for (const l of others) for (const t of (l.path || [])) keepTile.add(beltKey(t.x, t.y));
        for (const l of mine) for (const t of (l.path || [])) { const k = beltKey(t.x, t.y); if (!keepTile.has(k) && doc.belts[k]) { delete doc.belts[k]; dirty.push(cell(t.x, t.y)); } }
        for (const q of ps) if (isJunction(q) && mine.some(l => l.from.prop === q.id || l.to.prop === q.id)) { const k = beltKey(q.x, q.y); if (!keepTile.has(k) && doc.belts[k]) { delete doc.belts[k]; dirty.push(cell(q.x, q.y)); } }
        if (Array.isArray(doc.links)) doc.links = others;
        for (const q of ps) { q.x += dTx; q.y += dTy; }
        dropRoomIdx();
        for (const q of ps) {
          const v = checkProp(propFootprint(q), q.id, q.t, set);
          if (!v.ok) return Object.assign({}, v, { prop: q.id });
          dirty.push(propFootprint(q));
        }
        const relaid = [], lost = [], ends = new Set();
        for (const l of mine) {
          const A = propById(l.from.prop), B = propById(l.to.prop);
          const r = (A && B) ? planBelt(A, B, true) : fail('NOT_FOUND', 'no such prop');
          if (!r.ok) { lost.push({ id: l.id, from: l.from.prop, to: l.to.prop, msg: r.msg }); continue; }
          for (const d of layBelt(A, B, r, true, l)) dirty.push(d);
          relaid.push(l.id); ends.add(A.id); ends.add(B.id);
        }
        if (lost.length) return { ok: false, error: 'LINK_LOST', msg: 'moving these together would take up a belt link — move those machines one at a time (their belts follow)', lost };
        for (const id of ends) { const J = propById(id); if (J && isJunction(J)) syncJunctionCfg(J); }
        emit(dirty, { staticBakeUnchanged: !ps.some(q => q.t === 'airlock') });
        return { ok: true, relaid };
      });
    }
    /* lift every link between machine p and another machine (the belt tiles no other link rides), run `mutate` (the move),
       then lay each one again with the connect planner — same two machines, same id, same ports. A junction's own tile
       moves with it. Junctions at either end then take their compass config from the re-laid lanes (syncJunctionCfg), so
       a FILTER's CODE lane is still its CODE lane whichever side it now leaves from. No snapshot, no emit. */
    function relayLinksOf(p, mutate) {
      const L = Array.isArray(doc.links) ? doc.links : [];
      const touches = l => l && l.from && l.to && (l.from.prop === p.id || l.to.prop === p.id);
      const mine = L.filter(l => touches(l) && l.from.prop != null && l.to.prop != null && l.from.prop !== l.to.prop);
      const others = L.filter(l => mine.indexOf(l) < 0);
      const keepTile = new Set();
      for (const l of others) for (const t of (l.path || [])) keepTile.add(beltKey(t.x, t.y));
      const dirty = [], cell = (x, y) => ({ x1: x, y1: y, x2: x, y2: y });
      for (const l of mine) for (const t of l.path) { const k = beltKey(t.x, t.y); if (!keepTile.has(k) && doc.belts[k]) { delete doc.belts[k]; dirty.push(cell(t.x, t.y)); } }
      if (isJunction(p) && mine.length) { const k = beltKey(p.x, p.y); if (!keepTile.has(k) && doc.belts[k]) { delete doc.belts[k]; dirty.push(cell(p.x, p.y)); } }
      doc.links = others;
      mutate();
      const relaid = [], lost = [], ends = new Set();
      for (const l of mine) {
        const A = propById(l.from.prop), B = propById(l.to.prop);
        const r = (A && B) ? planBelt(A, B, true) : fail('NOT_FOUND', 'no such prop');
        if (!r.ok) { lost.push({ id: l.id, from: l.from.prop, to: l.to.prop, msg: r.msg }); continue; }
        for (const d of layBelt(A, B, r, true, l)) dirty.push(d);
        relaid.push(l.id); ends.add(A.id); ends.add(B.id);
      }
      for (const id of ends) { const J = propById(id); if (J && isJunction(J)) syncJunctionCfg(J); }
      return { dirty, relaid, lost };
    }
    // the lane (compass dir) each of junction J's out-links leaves on — from its tile to the link's first belt (or, belt-less,
    // to the next junction) — paired with the link
    function junctionOutLanes(J) {
      const out = [], dirTo = (a, b) => (b.x > a.x ? 'E' : b.x < a.x ? 'W' : b.y > a.y ? 'S' : 'N');
      for (const l of (Array.isArray(doc.links) ? doc.links : [])) {
        if (!l || !l.from || l.from.prop !== J.id) continue;
        const nb = (l.path && l.path[0]) || (l.to && l.to.prop != null && propById(l.to.prop));
        if (nb && Math.abs(nb.x - J.x) + Math.abs(nb.y - J.y) === 1) out.push({ link: l, dir: dirTo(J, nb) });
      }
      return out;
    }
    /* a junction's compass config FROM its links (after its lanes moved): a FILTER routes each tag down the lane of the link
       carrying it and its default down the EVERYTHING ELSE link; a LOOP's done / esc are its done / esc links' lanes. Only
       what a link names is rewritten — config no link speaks for is left as it was. Keeps an older build (which reads the
       compass) and the panel reading the same routes the compiler does. */
    function syncJunctionCfg(J) {
      const lanes = junctionOutLanes(J);
      if (J.t === 'filter') {
        const named = lanes.filter(o => (Array.isArray(o.link.from.tags) && o.link.from.tags.length) || o.link.from.else);
        if (!named.length) return;
        const routes = {};
        for (const o of named) for (const tag of (o.link.from.tags || [])) if (!(tag in routes)) routes[tag] = o.dir;
        const def = (named.find(o => o.link.from.else) || {}).dir || null;
        if (Object.keys(routes).length) J.routes = routes; else delete J.routes;
        if (def) J.def = def; else if (named.some(o => o.link.from.else)) delete J.def;
      } else if (J.t === 'loop') {
        const done = lanes.find(o => o.link.from.port === 'done'), esc = lanes.find(o => o.link.from.port === 'esc');
        if (done) J.done = done.dir;
        if (esc) J.esc = esc.dir;
      }
    }

    /* ---------- belt mutations ----------
       A belt tile must sit on a deck and not on a blocking prop. Belts are 1×1, keyed by tile;
       setBelt overwrites the direction in place (re-laying over a belt just re-aims it). */
    function beltPlaceable(x, y) {
      if (!roomAt(x, y)) return fail('OFF_DECK', 'belts must sit on a deck');
      const pid = propAt(x, y);
      if (pid) { const p = propById(pid); if (p && p.block !== false) return fail('ON_PROP', 'a prop is in the way'); }
      return { ok: true };
    }
    function setBelt(x, y, dir) {
      x |= 0; y |= 0;
      if (!DIRS[dir]) return fail('BAD_DIR', 'bad belt direction');
      const v = beltPlaceable(x, y); if (!v.ok) return v;
      if (doc.belts[beltKey(x, y)] === dir) return { ok: true };   // no-op: don't burn an undo slot
      snapshot();
      doc.belts[beltKey(x, y)] = dir;
      emit([{ x1: x, y1: y, x2: x, y2: y }]);
      return { ok: true };
    }
    function removeBelt(x, y) {
      const k = beltKey(x, y);
      if (!doc.belts[k]) return fail('NOT_FOUND', 'no belt here');
      snapshot();
      delete doc.belts[k];
      emit([{ x1: x | 0, y1: y | 0, x2: x | 0, y2: y | 0 }]);
      return { ok: true };
    }
    // batch-remove a set of belt tiles in ONE undo slot (a RECLAIM drag clearing a whole run —
    // mirrors placeBeltRun's single-snapshot shape so one UNDO restores the lot). Tiles with no belt
    // are silently skipped; an all-empty request is a no-op fail so the caller can flag "no belts".
    function removeBelts(tiles) {
      const hit = (tiles || []).map(t => [t[0] | 0, t[1] | 0]).filter(([x, y]) => doc.belts[beltKey(x, y)]);
      if (!hit.length) return fail('NOT_FOUND', 'no belts here');
      snapshot();
      const dirty = [];
      for (const [x, y] of hit) { delete doc.belts[beltKey(x, y)]; dirty.push({ x1: x, y1: y, x2: x, y2: y }); }
      emit(dirty);
      return { ok: true, count: hit.length };
    }
    // lay a straight run a→b; direction = the dominant drag axis (drag east → E belts, etc.)
    function placeBeltRun(a, b) {
      const ax = a.tx | 0, ay = a.ty | 0, bx = b.tx | 0, by = b.ty | 0;
      const dx = bx - ax, dy = by - ay;
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const dir = horiz ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
      const tiles = [];
      if (horiz) { const s = dx >= 0 ? 1 : -1; for (let x = ax; x !== bx + s; x += s) tiles.push([x, ay]); }
      else { const s = dy >= 0 ? 1 : -1; for (let y = ay; y !== by + s; y += s) tiles.push([ax, y]); }
      // validate every tile first so a run is all-or-nothing (the ghost already tinted it)
      for (const [x, y] of tiles) { const v = beltPlaceable(x, y); if (!v.ok) return v; }
      const dirty = [];
      let changed = false;
      // single snapshot for the whole run
      const prev = clone(doc.belts);
      for (const [x, y] of tiles) { const k = beltKey(x, y); if (doc.belts[k] !== dir) changed = true; doc.belts[k] = dir; dirty.push({ x1: x, y1: y, x2: x, y2: y }); }
      if (!changed) { doc.belts = prev; return { ok: true }; }
      doc.belts = prev; snapshot();                                  // snapshot the pre-run state
      for (const [x, y] of tiles) doc.belts[beltKey(x, y)] = dir;
      emit(dirty);
      return { ok: true, dir, count: tiles.length };
    }
    const canPlaceBeltRun = (a, b) => {
      const ax = a.tx | 0, ay = a.ty | 0, bx = b.tx | 0, by = b.ty | 0;
      const horiz = Math.abs(bx - ax) >= Math.abs(by - ay);
      const tiles = [];
      if (horiz) { const s = bx >= ax ? 1 : -1; for (let x = ax; x !== bx + s; x += s) tiles.push([x, ay]); }
      else { const s = by >= ay ? 1 : -1; for (let y = ay; y !== by + s; y += s) tiles.push([ax, y]); }
      for (const [x, y] of tiles) { const v = beltPlaceable(x, y); if (!v.ok) return v; }
      return { ok: true };
    };

    /* ---------- INSERT A STEP (workflow panel "+" on a belt, 2026-09-22) ----------
       insertBayBetween(fromId, toId, {role, w, h, block}) puts a NEW BAY on the line between two machines that
       one belt connects directly: the old lane is lifted, a bay is placed on clear deck near where that lane
       ran, and connectBelt lays from -> new -> to. ONE undo slot, all-or-nothing (transact). It REFUSES —
       nothing changes — when the lane is not a plain direct belt (it passes another machine, or merges with a
       lane from elsewhere), or when no nearby spot both fits a bay and lets both belts lay themselves. */
    function directLane(A, B) {
      const inFoot = (p, x, y) => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1);
      const ringSet = p => { const out = new Set(), w = p.w || 1, h = p.h || 1;
        for (let y = p.y - 1; y <= p.y + h; y++) for (let x = p.x - 1; x <= p.x + w; x++) if (!inFoot(p, x, y)) out.add(x + ',' + y);
        return out; };
      const aRing = ringSet(A), bRing = ringSet(B);
      const others = doc.props.filter(p => CONNECTABLE[p.t] && p.id !== A.id && p.id !== B.id);
      const touchesOther = (x, y) => others.some(p => inFoot(p, x, y) || ringSet(p).has(x + ',' + y));
      const feeders = (x, y) => { let n = 0; for (const d in DIRS) { const v = DIRS[d], nd = doc.belts[beltKey(x - v[0], y - v[1])]; if (nd === d) n++; } return n; };
      const heads = [];
      for (const k of aRing) { const p = k.split(','), x = +p[0], y = +p[1]; if (doc.belts[k] && !feeders(x, y)) heads.push({ x, y }); }
      let why = null;
      for (const h0 of heads) {
        const tiles = [], seen = new Set();
        let t = h0, reached = false, bad = null, mergeAt = -1;
        while (t && doc.belts[beltKey(t.x, t.y)] && !seen.has(beltKey(t.x, t.y))) {
          const k = beltKey(t.x, t.y); seen.add(k);
          /* ANOTHER BELT JOINS HERE (2026-09-27 audit B3). On a stamped REVISION LOOP the gate's return belt joins the
             INBOX lane just before the writer, so every insert between INBOX and WRITER — the natural place for a
             research step — was refused. The new BAY goes in BEFORE the join: only the lane's own segment up to the
             join is lifted, the shared part stays (it still carries the other belt's work to B), and the new bay is
             belted into B on a lane of its own. The walk carries on so PASSES and reaching B are still checked. */
          if (tiles.length && mergeAt < 0 && feeders(t.x, t.y) > 1) mergeAt = tiles.length;
          if (!aRing.has(k) && !bRing.has(k) && touchesOther(t.x, t.y)) { bad = 'PASSES'; break; }
          tiles.push({ x: t.x, y: t.y });
          if (bRing.has(k)) reached = true;
          const v = DIRS[doc.belts[k]], nx = t.x + v[0], ny = t.y + v[1];
          if (reached && !bRing.has(beltKey(nx, ny))) break;   // the lane's tail runs out along B's ring
          t = { x: nx, y: ny };
        }
        if (reached && !bad) return mergeAt > 0 ? { ok: true, tiles: tiles.slice(0, mergeAt), beforeJoin: true } : { ok: true, tiles };
        if (bad) why = bad;
      }
      if (why === 'PASSES') return fail('LANE_PASSES', 'this belt passes another machine, so a step cannot be added here automatically. Add it by hand: Conveyors › MACHINES › BAY, then connect it with BELT');
      return fail('NO_DIRECT_LANE', 'no single belt runs straight from the first machine to the next, so a step cannot be added here automatically. Add it by hand: Conveyors › MACHINES › BAY, then connect it with BELT');
    }
    /* the compiler's own verdict on a trial insert: with probe agents on any uncrewed endpoint, the compiled plan
       must hand A's work to the new bay and the new bay's to B (or ship it to B when B is an OUTBOX), with no
       new blocking error. The probe ids never persist — the props are restored before returning. */
    /* what the REST of the floor routes to, with probe agents on the named uncrewed bays: every loop gate's back target
       and every dock's hand-off targets (dock-keyed — prop ids survive an origin shift). insertBayBetween compares this
       before and after, so an insert can never quietly re-route a lane it was not asked to touch (2026-09-27: a new
       research step parked beside a REVISION LOOP's return belt became the gate's back target). */
    function routingSummary(probeIds) {
      const P = pipelineModule();
      if (!P || !P.compileRoutingPlan) return null;
      const probes = [];
      for (const id of probeIds) { const p = doc.props.find(q => q.id === id); if (p && p.t === 'bay' && !p.agentId) { p.agentId = '__insert_probe_' + probes.length; probes.push(p); } }
      let out = null;
      try {
        const plan = P.compileRoutingPlan(projectGeometry());
        const backs = [];
        for (const k in (plan.gateDocks || {})) { const g = plan.gateDocks[k]; backs.push(String(g && g.backTo || '') + '>' + String(g && g.escTo || '')); }
        const next = {};
        for (const d in (plan.dockChains || {})) next[d] = (plan.dockChains[d].next || []).slice().sort().join(',') + (plan.dockChains[d].outbox ? '+out' : '');
        out = { backs: backs.sort().join('|'), next };
      } catch (e) { out = null; }
      for (const p of probes) delete p.agentId;
      return out;
    }
    function insertCompiles(A, newId, B, before) {
      const P = pipelineModule();
      if (!P || !P.compileRoutingPlan) return true;   // no compiler loaded: the geometric checks stand alone
      if (before) {
        const after = routingSummary([A.id, newId, B.id]);
        if (!after || after.backs !== before.backs) return false;   // a loop gate would send work somewhere new
        for (const d in before.next) if (d !== A.id && d !== newId && after.next[d] !== before.next[d]) return false;   // another dock re-routed
      }
      const probes = [];
      const probe = id => { const p = doc.props.find(q => q.id === id); if (p && p.t === 'bay' && !p.agentId) { p.agentId = '__insert_probe_' + probes.length; probes.push(p); } return p; };
      const a = probe(A.id), n = probe(newId), b = probe(B.id);
      let ok = false;
      try {
        const plan = P.compileRoutingPlan(projectGeometry());
        const blocking = (plan.errors || []).filter(e => !e.warn);
        const ch = plan.chains || {};
        const intoNew = a.t === 'bay' ? !!(ch[a.agentId] && ch[a.agentId].next.indexOf(n.agentId) >= 0)
          : a.t === 'intake' ? !!(plan.reach && plan.reach[n.agentId]) : true;
        const outOfNew = b.t === 'bay' ? !!(ch[n.agentId] && ch[n.agentId].next.indexOf(b.agentId) >= 0)
          : b.t === 'outbox' ? !!(ch[n.agentId] && ch[n.agentId].outbox) : !!(ch[n.agentId] && (ch[n.agentId].next.length || ch[n.agentId].gated || ch[n.agentId].outbox));
        ok = !blocking.length && intoNew && outOfNew;
      } catch (e) { ok = false; }
      for (const p of probes) delete p.agentId;
      return ok;
    }
    /* the + button's DRY RUN (2026-09-27 audit B3): would insertBayBetween succeed here? The Workflow panel greys out a "+"
       that can only refuse and says why on hover, instead of offering a role picker that ends in an error. The lane rules
       alone were not enough (2026-09-28 retest): the "+" between a REVISION LOOP's two bays in the starter room passed them,
       and the insert then refused NO_ROOM. So the answer is the REAL insert, run on a throwaway copy of this floor (the
       replaceLayout probe pattern) with the same bay size, cached per floor version so the panel's repaints stay free. */
    const insertProbe = { seq: -1, memo: {} };
    function canInsertBayBetween(fromId, toId, o) {
      const A = propById(fromId), B = propById(toId);
      if (!A || !B) return fail('NOT_FOUND', 'no such prop');
      if (!CONNECTABLE[A.t] || !CONNECTABLE[B.t]) return fail('NOT_CONNECTABLE', 'insert between workflow machines');
      const lane = directLane(A, B);
      if (!lane.ok) return lane;
      if (insertProbe.seq !== seq) { insertProbe.seq = seq; insertProbe.memo = {}; }
      const size = { w: (o && o.w) | 0, h: (o && o.h) | 0, block: !(o && o.block === false) };
      const k = fromId + '>' + toId + ':' + size.w + 'x' + size.h + (size.block ? '' : 'w');
      if (!insertProbe.memo[k]) {
        let r;
        try { r = makeStation(clone(doc)).insertBayBetween(fromId, toId, size); } catch (e) { r = fail('THREW', String((e && e.message) || e)); }
        insertProbe.memo[k] = (r && r.ok) ? { ok: true, beforeJoin: !!lane.beforeJoin } : (r || fail('NO_ROOM', 'no room for a new BAY here'));
      }
      return insertProbe.memo[k];
    }
    function insertBayBetween(fromId, toId, o) {
      const A = propById(fromId), B = propById(toId);
      if (!A || !B) return fail('NOT_FOUND', 'no such prop');
      if (!CONNECTABLE[A.t] || !CONNECTABLE[B.t]) return fail('NOT_CONNECTABLE', 'insert between workflow machines');
      const lane = directLane(A, B);
      if (!lane.ok) return lane;
      const W = Math.max(1, ((o && o.w) | 0) || 2), H = Math.max(1, ((o && o.h) | 0) || 2);
      const role = (o && typeof o.role === 'string' && BAY_ROLES[o.role]) ? o.role : null;
      const block = !(o && o.block === false);
      const mid = lane.tiles[lane.tiles.length >> 1];
      const cands = [];
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) cands.push({ x: mid.x + dx - (W >> 1), y: mid.y + dy - (H >> 1), d: dx * dx + dy * dy });
      cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
      const before = routingSummary([A.id, B.id]);
      return transact(() => {
        for (const t of lane.tiles) delete doc.belts[beltKey(t.x, t.y)];
        emit(lane.tiles.map(t => ({ x1: t.x, y1: t.y, x2: t.x, y2: t.y })));
        let tried = 0;
        for (const c of cands) {
          if (tried > 60) break;
          let clear = true;
          for (let y = c.y; y < c.y + H && clear; y++) for (let x = c.x; x < c.x + W && clear; x++) if (doc.belts[beltKey(x, y)]) clear = false;
          if (!clear || !checkProp({ x1: c.x, y1: c.y, x2: c.x + W - 1, y2: c.y + H - 1 }, null, 'bay').ok) continue;
          // a dock's 1-tile ring is its hookup zone: a new bay whose ring touches another machine (or its ring)
          // would share hookup tiles with it and the compiler would read the wrong hand-offs — keep clear
          if (doc.props.some(p => CONNECTABLE[p.t] && p.x - 1 <= c.x + W && p.x + (p.w || 1) >= c.x - 1 && p.y - 1 <= c.y + H && p.y + (p.h || 1) >= c.y - 1)) continue;
          // …and clear of every OTHER belt: a bay whose ring touches a passing lane HOOKS that lane (the lanes this insert
          // lays for itself come after, and belong to it)
          let brushes = false;
          for (let y = c.y - 1; y <= c.y + H && !brushes; y++) for (let x = c.x - 1; x <= c.x + W && !brushes; x++)
            if (!(x >= c.x && x < c.x + W && y >= c.y && y < c.y + H) && doc.belts[beltKey(x, y)]) brushes = true;
          if (brushes) continue;
          tried++;
          const pre = snap();
          const add = addProp({ t: 'bay', x: c.x, y: c.y, w: W, h: H, block });
          if (!add.ok) { restore(pre); continue; }
          if (role) { const np = doc.props.find(q => q.id === add.id); if (np) np.role = role; }
          const c1 = connectBelt(A.id, add.id);
          const c2 = c1.ok ? connectBelt(add.id, B.id) : c1;
          if (!c1.ok || !c2.ok) { restore(pre); continue; }
          if (!insertCompiles(A, add.id, B, before)) { restore(pre); continue; }
          return { ok: true, id: add.id, x: c.x, y: c.y, removed: lane.tiles.length, laid: (c1.count || 0) + (c2.count || 0) };
        }
        return fail('NO_ROOM', 'no clear spot near this belt fits a new BAY with both belts. Make floor space, or place one yourself (Conveyors › MACHINES › BAY) and connect it with BELT');
      });
    }

    /* ---------- LINE EDITS (conveyor-links phase D, 2026-09-29) ----------
       A LINE is the machines its links join. lineGraph(id) hands the layout engine (linelayout.js) the line holding that
       machine as a graph — every machine PINNED where it stands, every link with the belt it rides — plus the floor WITHOUT
       the line (everything a new layout must go round). applyLineLayout(graph, layout) writes the engine's answer back in
       ONE undo slot, all-or-nothing: the line's old belts are lifted, a machine gone from the graph is removed, a new one is
       placed and a moved one moved, every belt is laid and every link written, and each junction takes its compass config
       from its lanes. A machine that cannot stand where it lands, or a belt off the deck, fails the whole edit. */
    function lineOf(propId) {
      const L = currentLinks();
      const start = propById(propId);
      if (!Array.isArray(L) || !start || !LINK_MACHINES[start.t]) return null;
      const seen = new Set([start.id]), queue = [start.id];
      while (queue.length) {
        const id = queue.shift();
        for (const l of L) {
          if (!l || !l.from || !l.to) continue;
          const other = l.from.prop === id ? l.to.prop : l.to.prop === id ? l.from.prop : null;
          if (other != null && !seen.has(other) && propById(other)) { seen.add(other); queue.push(other); }
        }
      }
      return { ids: Array.from(seen), links: L.filter(l => l && l.from && l.to && seen.has(l.from.prop) && seen.has(l.to.prop)) };
    }
    function lineGraph(propId) {
      // no machine named: an empty line on the whole floor (where a NEW line is laid)
      const line = propId == null ? (Array.isArray(currentLinks()) ? { ids: [], links: [] } : null) : lineOf(propId);
      if (!line) return fail('NOT_LINKED', 'this machine is not on a floor that builds by links');
      const nodes = line.ids.map(id => {
        const p = propById(id), n = { id, t: p.t, w: p.w || 1, h: p.h || 1, pin: { x: p.x, y: p.y } };
        if (p.role) n.role = p.role;
        if (p.agentId) n.agentId = p.agentId;
        return n;
      });
      const links = line.links.map(l => {
        const from = { node: l.from.prop, port: l.from.port || 'out' };
        if (Array.isArray(l.from.tags) && l.from.tags.length) from.tags = l.from.tags.slice();
        if (l.from.else) from.else = true;
        return { id: l.id, from, to: { node: l.to.prop }, path: (l.path || []).map(t => ({ x: t.x, y: t.y, d: t.d })) };
      });
      // the floor round the line: every room, whatever else stands there, every belt this line's links do not ride alone
      const mine = new Set(line.ids), ownTiles = new Set();
      for (const l of line.links) for (const t of (l.path || [])) ownTiles.add(beltKey(t.x, t.y));
      for (const id of line.ids) { const p = propById(id); if (isJunction(p)) ownTiles.add(beltKey(p.x, p.y)); }
      for (const l of currentLinks()) if (!(mine.has(l.from.prop) && mine.has(l.to.prop))) for (const t of (l.path || [])) ownTiles.delete(beltKey(t.x, t.y));
      const rects = [], blocked = [], junctions = [], belts = {};
      for (const id of doc.order) for (const r of doc.rooms[id].rects) rects.push({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
      for (const p of doc.props) {
        if (mine.has(p.id) || ruleOf(p.t).flat) continue;   // a rug is deck paint: a machine may stand on it
        blocked.push({ x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 });
        if (isJunction(p)) junctions.push({ x: p.x, y: p.y });
      }
      for (const k in doc.belts) if (!ownTiles.has(k)) belts[k] = doc.belts[k];
      return { ok: true, graph: { nodes, links }, floor: { rects, blocked, belts, junctions } };
    }
    /* A READY-MADE LINE AS A GRAPH (conveyor-links phase E): its machines — each with everything a stamp gives it (a BAY's
       role, an INBOX's name and budget, a junction's routes / passes / verdict, the card's SET UP BEFORE YOU PLACE cap and
       tries) — and the links its drawn belts make (the same derivation a stamped floor adopts). The layout engine lays it
       out wherever the drawn tile map will not go (LineEdit.placeBlueprint); applyLineLayout writes it, one undo. */
    function blueprintGraph(id, opts) {
      const bp = blueprintById(id);
      if (!bp) return fail('NOT_FOUND', 'no such blueprint');
      const P = pipelineModule();
      if (!P || typeof P.deriveLinks !== 'function') return fail('NO_COMPILER', 'the line compiler is not loaded');
      const ov = (opts && typeof opts === 'object') ? opts : {};
      const CFG = ['routes', 'def', 'bufferSize', 'timeoutMin', 'maxIter', 'done', 'esc', 'when'];
      const nodes = bp.props.map((sp, i) => {
        const n = { id: 'b' + i, t: sp.t, w: sp.w || 1, h: sp.h || 1 };
        if (sp.block === false) n.block = false;
        if (sp.role && BAY_ROLES[sp.role]) n.role = sp.role;
        if (sp.t === 'intake' && typeof sp.label === 'string' && sp.label.trim()) n.label = sp.label.trim().slice(0, 48);
        if (sp.t === 'intake' && (sp.limits || (ov.limits && typeof ov.limits === 'object'))) n.limits = Object.assign({}, sp.limits || {}, ov.limits || {});
        const cfg = {};
        for (const k of CFG) if (sp[k] != null) cfg[k] = sp[k];
        if (sp.t === 'loop' && ov.maxIter != null) cfg.maxIter = ov.maxIter;
        if (Object.keys(cfg).length) n.cfg = cfg;
        if (n.t === 'bay' && n.role) { const pb = { t: 'bay', role: n.role }; stampBrief(pb, ov.briefs); if (pb.brief) n.brief = pb.brief; if (pb.hands) n.hands = pb.hands; }
        return n;
      });
      const drawn = bp.props.map((sp, i) => {
        const o = { id: 'b' + i, t: sp.t, x: sp.x, y: sp.y, w: sp.w || 1, h: sp.h || 1 };
        if (sp.routes) o.routes = sp.routes; if (sp.def) o.def = sp.def; if (sp.done) o.done = sp.done;
        return o;
      });
      const links = P.deriveLinks({ props: drawn, belts: bp.belts.map(b => ({ x: b.x, y: b.y, dir: b.d })) })
        .filter(l => l && !l.ring && l.from && l.to && l.from.prop != null && l.to.prop != null)
        .map(l => {
          const from = { node: l.from.prop, port: l.from.port || 'out' };
          if (Array.isArray(l.from.tags) && l.from.tags.length) from.tags = l.from.tags.slice();
          if (l.from.else) from.else = true;
          return { id: l.id, from, to: { node: l.to.prop } };
        });
      return { ok: true, graph: { nodes, links }, label: bp.label };
    }
    function applyLineLayout(graph, L) {
      if (!graph || !Array.isArray(graph.nodes) || !L || !L.ok) return fail('NO_LAYOUT', 'there is no layout to lay');
      const first = graph.nodes.find(n => propById(n.id));
      const line = first ? lineOf(first.id) : { ids: [], links: [] };
      if (!line) return fail('NOT_LINKED', 'this line is not on a floor that builds by links');
      const oldLinkIds = new Set(line.links.map(l => l.id));
      return transact(() => {
        const dirty = [], cell = (x, y) => ({ x1: x, y1: y, x2: x, y2: y });
        const mine = new Set(line.ids), inLine = l => mine.has(l.from.prop) && mine.has(l.to.prop);
        const L0 = Array.isArray(doc.links) ? doc.links : [];
        // 1. lift the line: its belts (the tiles no other line's link rides), its junction tiles, its links
        const keepTile = new Set();
        for (const l of L0) if (!inLine(l)) for (const t of (l.path || [])) keepTile.add(beltKey(t.x, t.y));
        const lift = (x, y) => { const k = beltKey(x, y); if (!keepTile.has(k) && doc.belts[k]) { delete doc.belts[k]; dirty.push(cell(x, y)); } };
        for (const l of L0) if (inLine(l)) for (const t of (l.path || [])) lift(t.x, t.y);
        for (const id of line.ids) { const p = propById(id); if (p && isJunction(p)) lift(p.x, p.y); }
        doc.links = L0.filter(l => !inLine(l));
        // 2. a machine the graph no longer holds is removed
        const inGraph = new Set(graph.nodes.map(n => n.id));
        const gone = line.ids.filter(id => !inGraph.has(id));
        if (gone.length) {
          for (const id of gone) { const p = propById(id); if (p) dirty.push(propFootprint(p)); }
          doc.props = doc.props.filter(p => gone.indexOf(p.id) < 0);
          dropRoomIdx();
        }
        // 3. new machines placed, existing ones moved where the layout put them
        const idOf = {};
        for (const n of graph.nodes) {
          const at = L.nodes[n.id];
          if (!at) return fail('NO_LAYOUT', 'the layout has no place for a machine of this line');
          let p = propById(n.id);
          if (!p) {
            if (!LINK_MACHINES[n.t]) return fail('NOT_CONNECTABLE', 'a line is made of workflow machines');
            p = { id: 'p' + (doc._nid++), t: n.t, x: at.x | 0, y: at.y | 0, w: Math.max(1, n.w | 0 || 1), h: Math.max(1, n.h | 0 || 1) };
            if (n.block === false) p.block = false;
            if (n.role && BAY_ROLES[n.role]) p.role = n.role;
            if (typeof n.agentId === 'string' && n.agentId) p.agentId = n.agentId;
            if (n.t === 'bay') stampBrief(p, n.role && (n.brief || n.hands) ? { [n.role]: { does: n.brief, hands: n.hands } } : null);
            if (n.t === 'intake' && typeof n.label === 'string' && n.label.trim()) p.label = n.label.trim().slice(0, 48);
            if (n.t === 'intake' && n.limits && typeof n.limits === 'object') {   // through the one normalizer, as a stamp does
              const nl = normalizeLimits(n.limits);
              if (nl) p.limits = { maxHops: nl.maxHops, maxUsdPerMessage: nl.maxUsdPerMessage, maxUsdPerDay: nl.maxUsdPerDay };
            }
            applyJunctionCfg(p, n.cfg || {});
            doc.props.push(p);
          } else if (p.x !== at.x || p.y !== at.y) {
            dirty.push(propFootprint(p));
            p.x = at.x | 0; p.y = at.y | 0;
          }
          idOf[n.id] = p.id;
          dirty.push(propFootprint(p));
        }
        dropRoomIdx();
        for (const n of graph.nodes) {   // every machine of the line stands where it may (checked after all of them moved)
          const p = propById(idOf[n.id]), v = checkProp(propFootprint(p), p.id, p.t);
          if (!v.ok) return v;
        }
        // 4. every belt the layout lays (a junction's own tile included)
        for (const b of (L.belts || [])) {
          if (!DIRS[b.d]) return fail('BAD_DIR', 'bad belt direction');
          const v = beltPlaceable(b.x, b.y); if (!v.ok) return v;
          doc.belts[beltKey(b.x, b.y)] = b.d; dirty.push(cell(b.x, b.y));
        }
        // 5. its links: an old link keeps its id, a new one is numbered after the highest the floor held — the line's own
        //    lifted links included, so a new link never takes an old one's number (and pushes that link to another)
        const links = doc.links.slice(), placed = [];
        for (const l of (L.links || [])) {
          const from = { prop: idOf[l.from.prop], port: l.from.port || 'out' };
          if (Array.isArray(l.from.tags) && l.from.tags.length) from.tags = l.from.tags.slice();
          if (l.from.else) from.else = true;
          const id = (oldLinkIds.has(l.id) && !links.some(q => q.id === l.id)) ? l.id : nextLinkId(links.concat(L0));
          const link = { id, from, to: { prop: idOf[l.to.prop], port: 'in' }, path: (l.path || []).map(t => ({ x: t.x, y: t.y, d: t.d })) };
          links.push(link); placed.push(link);
        }
        doc.links = links;
        // 6. a junction's compass config follows its lanes (a FILTER's routes, a LOOP's done / escape)
        for (const n of graph.nodes) { const p = propById(idOf[n.id]); if (p && isJunction(p)) syncJunctionCfg(p); }
        emit(dirty, { staticBakeUnchanged: true });
        return { ok: true, ids: idOf, links: placed.map(l => l.id), removed: gone };
      });
    }

    /* ---------- CONNECT MODE (2026-07-05 UX reshape): connect MACHINES, not tiles ----------
       connectBelt(fromId, toId) lays a correctly-oriented belt path between two workflow props
       automatically: BFS over deck tiles (never through blocking props, never under ANY prop, never
       trampling an existing lane), flow from → to, the final tile aimed INTO the target's footprint so
       the crate visibly sinks at the dock. A junction that already sits ON a line starts its branch from
       a free neighbor (the out-lane forms naturally). All-or-nothing, one undo slot. This is what makes
       the tile-perfect wiring rules (ring adjacency, junction-on-line, direction) unlearnable-by-necessity:
       the user clicks INBOX then BAY, and the path knows the rules for them. */
    const CONNECTABLE = { intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 };
    /* 1x1 JUNCTIONS ARE ON-LINE MACHINES (2026-08-22 stranded-user fix). The compiler (pipeline.js) reads a
       splitter/joiner/loop/filter/merger by the belt UNDER its own tile: in-lanes are 4-neighbours flowing
       INTO that tile, out-lanes are 4-neighbours flowing away. The old connect path treated a junction like a
       dock — any pathable ring tile (corners included) was a goal and the junction's own tile was never laid
       — so the UI chimed CONNECTED while the compiler reported SPLIT_ONE_LANE / JOIN_ONE_LANE / BAY_NOT_FED.
       Now: a beltless junction is ENTERED/LEFT through its own tile (the lane runs through it, the junction
       tile takes the lane's heading); a junction already on a line is reached only by its 4-neighbours with
       the last tile aimed INTO it (an in-lane — a corner can never be one), or left from a free 4-neighbour
       (an out-lane). The would-be lane is checked against the compiler's own lane readers BEFORE a tile is
       written — a lane the compiler would not count is refused (honest failure, no chime), never laid. */
    const JUNCTION = { filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 };
    const isJunction = p => !!JUNCTION[p.t] && (p.w || 1) === 1 && (p.h || 1) === 1;
    /* CONNECT ON A LINKED FLOOR (conveyor-links phase B, 2026-09-28): the lane is a LINK — from this machine, to that
       one, along this belt — so it hooks exactly its two machines and nothing it passes. Three rules replace the old
       ring workarounds:
         · the belt's LAST tile sits in the destination's ring and NOT in a start machine's, so the tile the work arrives
           on belongs to the destination alone — two machines side by side get a belt round the far side, never a
           TOO CLOSE refusal or a spacing rule;
         · no tile but the lane's own two ends touches a junction's tile, or that junction would read it as a lane;
         · a third machine's ring is skirted on the first pass for tidiness only — passing it hooks nothing.
       A floor whose links were never adopted keeps the ring-rule behaviour (TOO CLOSE included), unchanged. */
    function connectBelt(fromId, toId) {
      const A = doc.props.find(p => p.id === fromId), B = doc.props.find(p => p.id === toId);
      if (!A || !B) return fail('NOT_FOUND', 'no such prop');
      if (A.id === B.id) return fail('SAME_PROP', 'pick two different machines');
      if (!CONNECTABLE[A.t] || !CONNECTABLE[B.t]) return fail('NOT_CONNECTABLE', 'connect workflow machines (INBOX/BAY/OUTBOX/junctions)');
      const linked = Array.isArray(currentLinks());
      const r = planBelt(A, B, linked);
      if (!r.ok) return r;
      snapshot();   // one undo slot for the whole connection
      emit(layBelt(A, B, r, linked, null));
      return { ok: true, count: r.path.length, from: A.t, to: B.t };
    }
    // the next free link id (l1, l2, …) — ids are never reused while a link still holds one
    function nextLinkId(links) {
      let n = 0;
      for (const l of (links || [])) { const m = l && /^l(\d+)$/.exec(String(l.id)); if (m) n = Math.max(n, +m[1]); }
      return 'l' + (n + 1);
    }
    // what a junction's lane `d` carries, read off its compass config (a FILTER's routed tags / EVERYTHING ELSE, a LOOP's
    // exit) — the same reading Pipeline.deriveLinks uses, so a drawn lane and a derived one mean the same thing
    function junctionPort(J, d) {
      const f = { prop: J.id, port: 'out' };
      if (J.t === 'filter') {
        const r = (J.routes && typeof J.routes === 'object') ? J.routes : {}, tags = [];
        for (const tag in r) if (r[tag] === d) tags.push(tag);
        if (tags.length) f.tags = tags;
        if (J.def === d) f.else = true;
      } else if (J.t === 'loop') { if (J.done === d) f.port = 'done'; else if (J.esc === d) f.port = 'esc'; }
      return f;
    }
    // the route a lane A -> B would take (pure: reads the doc, writes nothing) — { ok, path, dirs, exitTile, … } or a fail
    function planBelt(A, B, linked) {
      const inFoot = (p, x, y) => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1);
      const inBox = (p, x, y) => x >= p.x - 1 && x <= p.x + (p.w || 1) && y >= p.y - 1 && y <= p.y + (p.h || 1);
      const aJ = isJunction(A), bJ = isJunction(B);
      const aOn = !!doc.belts[beltKey(A.x, A.y)], bOn = !!doc.belts[beltKey(B.x, B.y)];
      // a path tile: on deck, not an existing belt, not under ANY prop (docks hook via ring adjacency) —
      // EXCEPT a beltless 1x1 junction endpoint's own tile: the lane must run THROUGH it
      const pathable = (x, y) => !doc.belts[beltKey(x, y)] && !!roomAt(x, y)
        && (!propAt(x, y) || (aJ && !aOn && x === A.x && y === A.y) || (bJ && !bOn && x === B.x && y === B.y));
      // the 1-tile ring around a footprint (the expanded rect minus the footprint) — matches beltTileNear's hookup scan
      const ring = p => {
        const out = [], w = p.w || 1, h = p.h || 1;
        for (let y = p.y - 1; y <= p.y + h; y++) for (let x = p.x - 1; x <= p.x + w; x++)
          if (!inFoot(p, x, y)) out.push({ x, y });
        return out;
      };
      const N4 = [[1, 0, 'E'], [-1, 0, 'W'], [0, 1, 'S'], [0, -1, 'N']];
      const dirTo = (a, b) => (b.x > a.x ? 'E' : b.x < a.x ? 'W' : b.y > a.y ? 'S' : 'N');
      const adj = (x, y, p) => Math.abs(x - p.x) + Math.abs(y - p.y) === 1;
      // LINKED: a tile beside any OTHER junction would be read as its lane — off limits. Beside an endpoint junction it is
      // only the lane's own first (A) or last (B) tile.
      const nearOther = new Set();
      if (linked) for (const p of doc.props) {
        if (!isJunction(p) || p.id === A.id || p.id === B.id) continue;
        for (const [dx, dy] of N4) nearOther.add(beltKey(p.x + dx, p.y + dy));
      }
      // START set: a beltless junction starts ON its own tile; a machine already ON a line branches from a
      // free 4-neighbor of its tile (an out-lane); anything else starts from a pathable ring tile.
      let starts = [];
      if (aJ && !aOn) { if (pathable(A.x, A.y)) starts.push({ x: A.x, y: A.y }); }
      else if (aOn) { for (const [dx, dy] of N4) { const x = A.x + dx, y = A.y + dy; if (pathable(x, y)) starts.push({ x, y }); } }
      else for (const t of ring(A)) if (pathable(t.x, t.y)) starts.push(t);
      if (linked) starts = starts.filter(t => !nearOther.has(beltKey(t.x, t.y)));
      if (!starts.length) return fail('FROM_BLOCKED', aJ ? 'no free tile beside the ' + A.t.toUpperCase() + ' to leave from — clear one of its four sides' : 'no free tile beside the start machine');
      // GOAL set: a beltless junction is entered THROUGH its own tile; a junction already on a line only via a
      // free 4-neighbour (the last tile aims INTO it = an in-lane); for docks, pathable ring tiles — EDGE tiles
      // preferred over corners, so the lane's last tile can aim straight INTO the footprint and the crate
      // visibly sinks at the dock (corners are the fallback when every edge is taken)
      const goalEdge = new Set(), goalCorner = new Set();
      if (bJ && !bOn) {
        // its own tile is the goal — but only reachable through one of its four sides (or straight out of A)
        const open = N4.some(([dx, dy]) => pathable(B.x + dx, B.y + dy) || inFoot(A, B.x + dx, B.y + dy));
        if (open && pathable(B.x, B.y)) goalEdge.add(B.x + ',' + B.y);
      }
      else if (bJ) { for (const [dx, dy] of N4) { const x = B.x + dx, y = B.y + dy; if (pathable(x, y)) goalEdge.add(x + ',' + y); } }
      else for (const t of ring(B)) {
        if (!pathable(t.x, t.y)) continue;
        const corner = (t.x < B.x || t.x >= B.x + (B.w || 1)) && (t.y < B.y || t.y >= B.y + (B.h || 1));
        (corner ? goalCorner : goalEdge).add(t.x + ',' + t.y);
      }
      if (linked) {
        // the tile work arrives on at a BAY is that bay's alone — never in the start machine's ring (a tile two docks share
        // belongs to one of them only) — and no arrival tile sits beside another junction
        const own = B.t === 'bay' && !aJ;
        for (const set of [goalEdge, goalCorner]) for (const k of [...set]) {
          const q = k.split(','), x = +q[0], y = +q[1];
          if ((own && inBox(A, x, y)) || nearOther.has(k)) set.delete(k);
        }
      } else if (!aJ && !bJ && B.t === 'bay' && (A.t === 'intake' || A.t === 'bay')) {
        /* TOO CLOSE (2026-09-27 audit B4, ring-rule floors only): when a job SOURCE sits within a tile of the BAY it
           feeds, their rings overlap, and a belt tile inside BOTH is read as the source's own mouth AND the bay's
           hookup at once — so the lane must START outside the destination's ring and END outside the source's; when no
           such tiles exist the two machines are simply too close, and we say so instead of laying a belt that can never
           carry work. (BAY→OUTBOX is exempt: a shared tile there is a valid ship-out mouth.) A linked floor has no such
           rule: its links say which machine each end belongs to. */
        const ringKeys = p => new Set(ring(p).map(t => t.x + ',' + t.y));
        const aRing = ringKeys(A), bRing = ringKeys(B);
        const tooClose = () => fail('TOO_CLOSE', 'these two machines are too close — a belt between them would touch both at once, so the job would never arrive. Move the ' + B.t.toUpperCase() + ' one tile further away, then connect again');
        for (let i = starts.length - 1; i >= 0; i--) if (bRing.has(starts[i].x + ',' + starts[i].y)) starts.splice(i, 1);
        if (!starts.length) return tooClose();
        for (const k of [...goalEdge]) if (aRing.has(k)) goalEdge.delete(k);
        for (const k of [...goalCorner]) if (aRing.has(k)) goalCorner.delete(k);
        if (!goalEdge.size && !goalCorner.size) return tooClose();
      }
      const goals = goalEdge.size ? goalEdge : goalCorner;
      if (!goals.size) return fail('TO_BLOCKED', bJ ? 'no free tile beside the ' + B.t.toUpperCase() + ' to enter it from — clear one of its four sides' : 'no free tile beside the destination');
      /* A LANE THAT BRUSHES A THIRD MACHINE HOOKS IT (2026-08-22, ring-rule floors): the compiler treats EVERY belt tile in
         a machine's 1-tile ring as a hookup, so a shortest path that hugged the reviewer's ring on its way back to the
         writer made the reviewer its own next stage (CHAIN_CYCLE) — a lane the user never drew. The ring tiles of every
         machine that is neither endpoint are avoided on the first pass; only when no route exists without them are they
         allowed. (On a linked floor passing hooks nothing — the skirt is kept for tidy floors.) */
      const foreignRing = new Set();
      for (const p of doc.props) {
        if (!CONNECTABLE[p.t] || p.id === A.id || p.id === B.id) continue;
        for (const t of ring(p)) foreignRing.add(t.x + ',' + t.y);
      }
      /* …AND SO DOES A LANE THAT ENDS IN ONE (2026-09-23 playtest). The first pass also prefers a goal tile no third
         machine touches — edge first, then corner — and only when none exists falls back to the whole goal set. */
      const cleanGoals = new Set([...goalEdge].filter(k => !foreignRing.has(k)));
      if (!cleanGoals.size) for (const k of goalCorner) if (!foreignRing.has(k)) cleanGoals.add(k);
      function bfs(avoid) {
        const want = (avoid && cleanGoals.size) ? cleanGoals : goals;
        const prev = new Map(), q = [];
        for (const s of starts) { const k = s.x + ',' + s.y; if (!prev.has(k) && !(avoid && foreignRing.has(k))) { prev.set(k, null); q.push(s); } }
        let hit = null, head = 0;
        while (head < q.length && !hit) {
          const t = q[head++];
          const tk = t.x + ',' + t.y;
          if (want.has(tk)) { hit = t; break; }
          // LINKED: a tile beside a beltless destination junction may only step onto that junction's own tile
          const preGoal = linked && bJ && !bOn && adj(t.x, t.y, B);
          for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const x = t.x + dx, y = t.y + dy, k = x + ',' + y;
            if (prev.has(k) || !pathable(x, y)) continue;
            if (avoid && foreignRing.has(k) && !want.has(k)) continue;
            if (linked) {
              if (preGoal && !(x === B.x && y === B.y)) continue;
              if (nearOther.has(k)) continue;
              // beside the start junction: only the first lane tile (a step straight off a beltless junction's own tile)
              if (aJ && adj(x, y, A) && !(!aOn && t.x === A.x && t.y === A.y)) continue;
              // beside the destination junction: only as the arrival (a goal), or the step onto a beltless one's tile
              if (bJ && adj(x, y, B) && !want.has(k) && bOn) continue;
            }
            prev.set(k, tk); q.push({ x, y });
          }
          if (q.length > 4096) return { err: fail('NO_PATH', 'no route found (path too long)') };
        }
        return { hit, prev };
      }
      let found = bfs(true);
      if (found.err) return found.err;
      if (!found.hit) { found = bfs(false); if (found.err) return found.err; }
      const hit = found.hit, prev = found.prev;
      if (!hit) return fail('NO_PATH', 'no clear route between these machines');
      // rebuild the path start→goal
      const path = [];
      let ck = hit.x + ',' + hit.y;
      while (ck) { const pp = ck.split(','); path.unshift({ x: +pp[0], y: +pp[1] }); ck = prev.get(ck); }
      // orient each tile at the next; the LAST tile aims into B's footprint (open-end sink at the dock)
      const dirs = [];
      for (let i = 0; i < path.length - 1; i++) dirs.push(dirTo(path[i], path[i + 1]));
      const last = path[path.length - 1];
      let endDir = null;
      if (bJ && !bOn) {
        // the lane runs THROUGH the junction: its tile keeps the lane's heading (away from where it came)
        if (dirs.length) endDir = dirs[dirs.length - 1];
        else for (const [dx, dy, d] of N4) if (inFoot(A, last.x - dx, last.y - dy)) { endDir = d; break; }
      } else for (const [dx, dy, d] of N4) if (inFoot(B, last.x + dx, last.y + dy)) { endDir = d; break; }
      dirs.push(endDir || (dirs.length ? dirs[dirs.length - 1] : 'E'));
      // PROVE THE LANE BEFORE LAYING IT: read the would-be map with the compiler's own lane readers
      // (Pipeline._internals) — the junction must count this lane exactly the way the chime will claim.
      const exitTile = aJ ? (aOn ? path[0] : (path.length > 1 ? path[1] : null)) : null;
      const P = (aJ || bJ) ? pipelineModule() : null;
      if (P && P._internals) {
        const map = {};
        for (const k in doc.belts) map[k] = doc.belts[k];
        for (let i = 0; i < path.length; i++) map[path[i].x + ',' + path[i].y] = dirs[i];
        if (bJ) {
          // the tile that feeds the junction. A beltless junction is ENTERED through its own tile, so the path ends
          // ON it and the feeder is the tile before; a junction already on a line is reached at a free 4-neighbour,
          // so the path's LAST tile is the feeder. Reading path[len-2] there (2026-09-27 audit W1) picked a tile
          // diagonal to the junction whenever the lane turned on its last step — a correct second in-lane into a
          // JOINER/MERGER was refused and the split-then-join shape could not be wired with clicks.
          const entry = bOn ? path[path.length - 1] : (path.length > 1 ? path[path.length - 2] : null);
          const sideIn = entry ? dirTo({ x: B.x, y: B.y }, entry) : null;
          const ins = P._internals.inLanes(map, B.x, B.y);
          if (!map[B.x + ',' + B.y] || (sideIn && ins.indexOf(sideIn) < 0))
            return fail('JUNCTION_NO_IN', 'that lane would not enter the ' + B.t.toUpperCase() + ' — the belt must run INTO its tile');
        }
        if (aJ) {
          const sideOut = exitTile ? dirTo({ x: A.x, y: A.y }, exitTile) : null;
          const outs = P._internals.outLanes(map, A.x, A.y);
          if (!map[A.x + ',' + A.y] || (sideOut && outs.indexOf(sideOut) < 0) || (!sideOut && !bJ))
            return fail('JUNCTION_NO_OUT', 'that lane would not leave the ' + A.t.toUpperCase() + ' — the belt must run OUT of its tile');
        }
      }
      return { ok: true, path, dirs, exitTile, aJ, bJ, aOn, bOn };
    }
    /* lay a planned lane (no snapshot, no emit — the caller owns both): the belt, a LOOP's done lane, the junction arrows,
       and on a linked floor the LINK itself. `keep` (a re-laid link: its id and ports) survives a MOVE. Returns the dirty
       rects. */
    function layBelt(A, B, r, linked, keep) {
      const { path, dirs, exitTile, aJ, bJ, aOn, bOn } = r;
      const dirTo = (a, b) => (b.x > a.x ? 'E' : b.x < a.x ? 'W' : b.y > a.y ? 'S' : 'N');
      const dirty = [];
      for (let i = 0; i < path.length; i++) { doc.belts[beltKey(path[i].x, path[i].y)] = dirs[i]; dirty.push({ x1: path[i].x, y1: path[i].y, x2: path[i].x, y2: path[i].y }); }
      /* a LOOP gate's DONE lane: connecting the gate to an OUTBOX names that lane `done` (unless the
         Commander already chose one). The compiler otherwise defaults to the first exit in E,S,W,N order,
         which on a floor whose back lane happens to sit east would send every spent crate BACK round. */
      if (A.t === 'loop' && B.t === 'outbox' && !A.done && exitTile && !keep) {
        A.done = dirTo({ x: A.x, y: A.y }, exitTile);
        dirty.push({ x1: A.x, y1: A.y, x2: A.x, y2: A.y });
      }
      /* a junction tile's own arrow must point at an OUT-lane: a joiner entered from the south while its tile
         still aimed south (the heading of the first lane that reached it) drew an arrow INTO an in-lane. The
         compiler never reads that arrow, but the floor does — re-aim it at the first out-lane. */
      const P = pipelineModule();
      if (P && P._internals) for (const J of [A, B]) {
        if (!isJunction(J)) continue;
        const jk = beltKey(J.x, J.y), cur = doc.belts[jk]; if (!cur) continue;
        const outs = P._internals.outLanes(doc.belts, J.x, J.y);
        if (outs.length && outs.indexOf(cur) < 0) { doc.belts[jk] = outs[0]; dirty.push({ x1: J.x, y1: J.y, x2: J.x, y2: J.y }); }
      }
      if (linked) {
        // the LINK: its path is the lane's belt, minus a beltless junction's own tile (that is now the tile it works on)
        let lp = path.map(t => ({ x: t.x, y: t.y, d: doc.belts[beltKey(t.x, t.y)] }));
        if (aJ && !aOn) lp = lp.slice(1);
        if (bJ && !bOn) lp = lp.slice(0, -1);
        const lane = aJ ? dirTo({ x: A.x, y: A.y }, exitTile || { x: B.x, y: B.y }) : null;
        const from = (keep && keep.from) ? Object.assign({}, keep.from, { prop: A.id }) : aJ ? junctionPort(A, lane) : { prop: A.id, port: 'out' };
        const links = Array.isArray(doc.links) ? doc.links.slice() : [];
        const id = (keep && keep.id && !links.some(l => l.id === keep.id)) ? keep.id : nextLinkId(links);
        links.push({ id, from, to: { prop: B.id, port: 'in' }, path: lp });
        doc.links = links;
      }
      return dirty;
    }

    /* ---------- CONNECTION PREVIEW: what would this placement hook? (2026-09-23 playtest) ----------
       The compiler hooks a machine to EVERY belt tile in its 1-tile ring (corners included) — "a dock touches
       the line wherever the line touches it". That is the routing law and it stays. What was wrong is that it
       happened SILENTLY: a line stamped right under another joined it while the ghost stayed green, and a
       bay dropped against a lane became a stage of it. A connection must be VISIBLE and INTENTIONAL, so the
       ghost asks this before the drop.
       connectionPreview({ props:[{t,x,y,w,h}], belts:[{x,y,d}], ignoreId }) -> [{ propId, t, agentId, label }]
       — the EXISTING workflow machines the candidate would hook up with, by the compiler's own reading:
         · a candidate machine whose footprint+ring covers an existing belt tile joins that belt's line;
         · a candidate belt tile inside an existing machine's footprint+ring hooks that machine;
         · a candidate belt flowing into an existing belt (or fed by one) joins that belt's line.
       A line = the belt component (4-neighbour, direction-blind — lineComponents' rule) plus every machine
       touching it. `ignoreId` is a machine being MOVED: it is left out, and so is every machine it is ALREADY
       lined up with (a nudge along its own lane is not a new connection). Pure: reads the doc, writes nothing. */
    function connectionPreview(cand) {
      if (Array.isArray(currentLinks())) return linkedPreview(cand);
      const cp = (cand && cand.props) || [], cb = (cand && cand.belts) || [], ignoreId = cand && cand.ignoreId;
      const machines = doc.props.filter(p => CONNECTABLE[p.t] && p.id !== ignoreId);
      const inZone = (p, x, y) => x >= p.x - 1 && x <= p.x + (p.w || 1) && y >= p.y - 1 && y <= p.y + (p.h || 1);
      const belts = doc.belts;
      // the line (belt component + touching machines) through a set of seed belt tiles
      const lineThrough = (seeds, skipId) => {
        const seen = new Set(), q = [];
        for (const k of seeds) if (belts[k] && !seen.has(k)) { seen.add(k); q.push(k); }
        while (q.length) {
          const k = q.shift(), p0 = k.split(','), x = +p0[0], y = +p0[1];
          for (const d in DIRS) { const nk = beltKey(x + DIRS[d][0], y + DIRS[d][1]); if (belts[nk] && !seen.has(nk)) { seen.add(nk); q.push(nk); } }
        }
        const out = new Set();
        if (!seen.size) return out;
        for (const m of doc.props) {
          if (!CONNECTABLE[m.t] || m.id === skipId) continue;
          let hit = false;
          for (let y = m.y - 1; y <= m.y + (m.h || 1) && !hit; y++) for (let x = m.x - 1; x <= m.x + (m.w || 1) && !hit; x++) if (seen.has(beltKey(x, y))) hit = true;
          if (hit) out.add(m.id);
        }
        return out;
      };
      const seeds = new Set(), direct = new Set();
      for (const c of cp) {
        if (!CONNECTABLE[c.t]) continue;
        const w = c.w || 1, h = c.h || 1;
        for (let y = c.y - 1; y <= c.y + h; y++) for (let x = c.x - 1; x <= c.x + w; x++) if (belts[beltKey(x, y)]) seeds.add(beltKey(x, y));
      }
      for (const b of cb) {
        for (const m of machines) if (inZone(m, b.x, b.y)) direct.add(m.id);
        const v = DIRS[b.d];
        if (v) { const nk = beltKey(b.x + v[0], b.y + v[1]); if (belts[nk]) seeds.add(nk); }
        for (const d in DIRS) { const nx = b.x - DIRS[d][0], ny = b.y - DIRS[d][1]; if (belts[beltKey(nx, ny)] === d) seeds.add(beltKey(nx, ny)); }
      }
      const hits = lineThrough(seeds, ignoreId);
      for (const id of direct) hits.add(id);
      if (ignoreId) {   // a MOVE: what the machine is already lined up with is not a new connection
        const me = doc.props.find(p => p.id === ignoreId);
        if (me) {
          const own = [];
          for (let y = me.y - 1; y <= me.y + (me.h || 1); y++) for (let x = me.x - 1; x <= me.x + (me.w || 1); x++) if (belts[beltKey(x, y)]) own.push(beltKey(x, y));
          for (const id of lineThrough(own, ignoreId)) hits.delete(id);
        }
        hits.delete(ignoreId);
      }
      return doc.props.filter(p => hits.has(p.id)).sort((a, b) => (a.x - b.x) || (a.y - b.y))
        .map(p => ({ propId: p.id, t: p.t, agentId: p.agentId || null, label: p.label || null }));
    }
    /* WILL IT CONNECT, ON A LINKED FLOOR (conveyor-links phase B): the dry run IS the real edit on a probe copy — place
       (or move) the candidate there and read which EXISTING machines it ends up linked with. A machine dropped beside a
       belt joins nothing; one dropped where a loose belt runs into it (or out of it) picks that belt up; a MOVE brings its
       own links along, so only a loose belt at the new spot is a new connection. Same answer shape as the ring rule's. */
    function linkedPreview(cand) {
      const cp = (cand && cand.props) || [], cb = (cand && cand.belts) || [], ignoreId = cand && cand.ignoreId;
      const probe = makeStation(clone(doc));
      const pairs = ls => new Set((ls || []).map(l => l.from.prop + '>' + l.to.prop));
      const before = pairs(probe.links()), mine = new Set();
      if (ignoreId) {
        const me = probe.propById(ignoreId), c = cp[0];
        if (!me || !c || !probe.moveProp(ignoreId, c.x - me.x, c.y - me.y).ok) return [];
        mine.add(ignoreId);
      } else for (const c of cp) {
        if (!CONNECTABLE[c.t]) continue;
        const r = probe.addProp({ t: c.t, x: c.x, y: c.y, w: c.w, h: c.h, block: c.block });
        if (r && r.ok) mine.add(r.id);
      }
      for (const b of cb) probe.setBelt(b.x, b.y, b.d);
      const hits = new Set();
      for (const l of (probe.links() || [])) {
        if (before.has(l.from.prop + '>' + l.to.prop)) continue;
        for (const id of [l.from.prop, l.to.prop]) if (id != null && !mine.has(id) && doc.props.some(p => p.id === id)) hits.add(id);
      }
      return doc.props.filter(p => hits.has(p.id)).sort((a, b) => (a.x - b.x) || (a.y - b.y))
        .map(p => ({ propId: p.id, t: p.t, agentId: p.agentId || null, label: p.label || null }));
    }
    // the lane a click A -> B would lay, without laying it — { ok, path:[{x,y,d}] } or { ok:false, msg } (REFIT draws it
    // under the cursor mid-connect, so the Commander sees where the belt will run before the click)
    function previewBelt(fromId, toId) {
      const A = doc.props.find(p => p.id === fromId), B = doc.props.find(p => p.id === toId);
      if (!A || !B || A.id === B.id || !CONNECTABLE[A.t] || !CONNECTABLE[B.t]) return { ok: false, msg: 'pick two different machines' };
      const r = planBelt(A, B, Array.isArray(currentLinks()));
      return r.ok ? { ok: true, path: r.path.map((t, i) => ({ x: t.x, y: t.y, d: r.dirs[i] })) } : { ok: false, error: r.error, msg: r.msg };
    }
    /* the belt tiles a machine is hooked to RIGHT NOW (its footprint + 1-tile ring) — REFIT's move ghost reads it
       to say "its belts stay here" when a drag would leave them behind (belts never ride along with a prop) */
    function hookedBelts(propId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p || !CONNECTABLE[p.t]) return [];
      const out = [];
      for (let y = p.y - 1; y <= p.y + (p.h || 1); y++) for (let x = p.x - 1; x <= p.x + (p.w || 1); x++) if (doc.belts[beltKey(x, y)]) out.push({ x, y });
      return out;
    }

    /* ---------- STARTER-LINE BLUEPRINTS (the beginner onramp, 2026-08-04) ----------
       A blueprint stamps a whole pre-wired conveyor layout — machines + belts — as ONE mutation
       behind ONE snapshot, so a single UNDO removes the entire line (per-piece stamping would
       burn an undo slot per prop and leave half-lines on a mid-stamp failure). Editing a working
       thing teaches; assembling from parts gatekeeps — so bays stamp UNBOUND (the existing amber
       "NO AGENT — CLICK" nag is the built-in next step) and the FILTER stamps pre-configured
       (routes + def) so a fresh stamp never introduces a warn the Commander didn't cause.
       Placement is all-or-nothing and requires CLEAR DECK for every tile: each machine passes the
       same checkProp a hand placement runs, each belt tile passes beltPlaceable, and nothing may
       stamp over an existing belt (overwriting a laid lane, or burying one under a dock, would
       corrupt a line the Commander already built — BELT_BURIED must never be stampable). */
    function blueprintById(id) { for (const b of BLUEPRINTS) if (b.id === id) return b; return null; }
    function checkBlueprint(bp, tx, ty) {
      if (!bp) return fail('NOT_FOUND', 'no such blueprint');
      tx |= 0; ty |= 0;
      for (const s of bp.props) {
        const x1 = tx + s.x, y1 = ty + s.y, x2 = x1 + s.w - 1, y2 = y1 + s.h - 1;
        const v = checkProp({ x1, y1, x2, y2 }, null, s.t);
        if (!v.ok) return v;
        for (let yy = y1; yy <= y2; yy++) for (let xx = x1; xx <= x2; xx++)
          if (doc.belts[beltKey(xx, yy)]) return fail('ON_BELT', 'a belt is already here');
      }
      for (const b of bp.belts) {
        const x = tx + b.x, y = ty + b.y;
        const v = beltPlaceable(x, y);
        if (!v.ok) return v;
        if (doc.belts[beltKey(x, y)]) return fail('ON_BELT', 'a belt is already here');
      }
      return { ok: true };
    }
    const canPlaceBlueprint = (id, tx, ty) => checkBlueprint(blueprintById(id), tx, ty);
    /* SET UP BEFORE YOU PLACE (2026-09-28): `opts` = { limits, maxIter } from the shelf card. They ride IN the stamp —
       the INBOX's budget through the same normalizer setPropLimits uses, the LOOP's pass cap through the same clamp its
       card uses — inside the ONE snapshot, so one UNDO still removes the whole line. */
    // a stamped BAY of a role the caller gave instructions for carries them (the bounds setPropBrief / setPropHands keep)
    function stampBrief(prop, briefs) {
      const b = prop && prop.t === 'bay' && prop.role && briefs && typeof briefs === 'object' ? briefs[prop.role] : null;
      if (!b || typeof b !== 'object') return;
      const does = typeof b.does === 'string' ? b.does.trim().slice(0, 2000) : '', hands = typeof b.hands === 'string' ? b.hands.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      if (does && !prop.brief) prop.brief = does;
      if (hands && !prop.hands) prop.hands = hands;
    }
    function stampBlueprint(id, tx, ty, opts) {
      const bp = blueprintById(id);
      const v = checkBlueprint(bp, tx, ty);
      if (!v.ok) return v;
      tx |= 0; ty |= 0;
      const ov = (opts && typeof opts === 'object') ? opts : {};
      snapshot();   // ONE undo slot for the whole line
      const ids = [], dirty = [];
      for (const s of bp.props) {
        const prop = { id: 'p' + (doc._nid++), t: s.t, x: tx + s.x, y: ty + s.y, w: s.w, h: s.h };
        if (s.block === false) prop.block = false;
        if (s.role && BAY_ROLES[s.role]) prop.role = s.role;   // guided workflows: the dock stamps carrying its ROLE (see BAY_ROLES)
        /* an INBOX may stamp pre-labeled and pre-budgeted (ALLOWANCE DESK, 2026-08-30) — through the
           SAME normalizer setPropLimits uses, so a blueprint can never write a number the executor
           would read differently. Both fields already round-trip via migrate()'s prop whitelist. */
        if (s.t === 'intake' && typeof s.label === 'string' && s.label.trim()) prop.label = s.label.trim().slice(0, 48);
        if (s.t === 'intake' && s.limits) {
          const nl = normalizeLimits(s.limits);
          if (nl) prop.limits = { maxHops: nl.maxHops, maxUsdPerMessage: nl.maxUsdPerMessage, maxUsdPerDay: nl.maxUsdPerDay };
        }
        applyJunctionCfg(prop, s);   // the FILTER's routes/def ride in pre-configured
        if (s.t === 'intake' && ov.limits && typeof ov.limits === 'object') {
          const nl = normalizeLimits(Object.assign({}, prop.limits || {}, ov.limits));
          if (nl) prop.limits = { maxHops: nl.maxHops, maxUsdPerMessage: nl.maxUsdPerMessage, maxUsdPerDay: nl.maxUsdPerDay };
        }
        if (s.t === 'loop' && ov.maxIter != null) applyJunctionCfg(prop, { maxIter: ov.maxIter });
        stampBrief(prop, ov.briefs);   // (a shelf line's steps land with their role's instructions — one undo with the line)
        doc.props.push(prop);
        ids.push(prop.id);
        dirty.push({ x1: prop.x, y1: prop.y, x2: prop.x + prop.w - 1, y2: prop.y + prop.h - 1 });
      }
      for (const b of bp.belts) {
        const x = tx + b.x, y = ty + b.y;
        doc.belts[beltKey(x, y)] = b.d;
        dirty.push({ x1: x, y1: y, x2: x, y2: y });
      }
      emit(dirty);
      return { ok: true, ids, props: bp.props.length, belts: bp.belts.length };
    }

    function renameRoom(id, name) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const nm = String(name || '').slice(0, 24) || rm.name;
      if (nm === rm.name) return { ok: true };   // no-op: don't burn an undo slot / wipe redo
      snapshot();
      rm.name = nm;
      emit([]);
      return { ok: true };
    }

    // Whole-layout changes use the same single-step history and invalidation as
    // ordinary REFIT edits. Assemble and validate before touching the live doc.
    function replaceLayout(layout) {
      if (!layout || layout.schema !== 'starnet.station' || !Array.isArray(layout.props) || !layout.rooms) return fail('BAD_LAYOUT');
      const candidate = migrate(clone(layout));
      if (!candidate.order.length || new Set(candidate.props.map(p => p.id)).size !== candidate.props.length) return fail('BAD_LAYOUT');
      const probe = makeStation(clone(candidate));
      for (const rid of candidate.order) {
        const room = candidate.rooms[rid];
        if (!room.rects.length || room.rects.some(r => ![r.x1,r.y1,r.x2,r.y2].every(Number.isFinite))) return fail('BAD_LAYOUT');
        const placed = probe.canPlaceRoom(room.rects, room.kind, rid);
        if (!placed.ok) return placed;
      }
      for (const p of candidate.props) {
        const placed = probe.canPlaceProp(p.t,p.x,p.y,p.w,p.h,p.id);
        if (!placed.ok) return placed;
      }
      const next = makeStation(candidate);
      const owners = [...new Set(doc.props.filter(p => p.agentId).map(p => p.agentId))];
      for (const aid of owners) {
        const placed = next.ensureWorkstation(aid);
        if (!placed.ok) return placed;
      }
      const prepared = next.serialize();
      prepared.meta.createdAt = doc.meta.createdAt;
      snapshot();
      restore(prepared);
      emit([], {global:true});
      return {ok:true};
    }

    function undo() {
      if (!undoStack.length) return fail('NOTHING', 'nothing to undo');
      redoStack.push(snap());
      restore(undoStack.pop());
      emit([]);   // empty dirty = full re-bake
      return { ok: true };
    }
    function redo() {
      if (!redoStack.length) return fail('NOTHING', 'nothing to redo');
      undoStack.push(snap());
      restore(redoStack.pop());
      emit([]);
      return { ok: true };
    }
    const canUndo = () => undoStack.length > 0;
    const canRedo = () => redoStack.length > 0;

    /* ---------- projection → the v7 MAP-shaped geometry the bake consumes ---------- */
    function projectGeometry(walls = {}) {
      const b = bounds();
      const ox = b.minTx - MARGIN, oy = b.minTy - MARGIN;       // world → local offset
      const COLS = (b.maxTx - b.minTx) + 1 + MARGIN * 2;
      const ROWS = (b.maxTy - b.minTy) + 1 + MARGIN * 2;
      const idx = (x, y) => y * COLS + x;
      const zoneGrid = new Array(COLS * ROWS).fill(null);
      const zones = {};            // id → local bounding rect
      const allRects = [];         // [{z,x1,y1,x2,y2}] local
      const ROOM_IDS = [];
      const corridor = {};

      for (const id of doc.order) {
        const rm = doc.rooms[id];
        const isCor = rm.kind === 'corridor';
        if (isCor) corridor[id] = true; else ROOM_IDS.push(id);
        let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
        for (const r of rm.rects) {
          const lr = { z: id, x1: r.x1 - ox, y1: r.y1 - oy, x2: r.x2 - ox, y2: r.y2 - oy };
          allRects.push(lr);
          for (let y = lr.y1; y <= lr.y2; y++) for (let x = lr.x1; x <= lr.x2; x++) zoneGrid[idx(x, y)] = id;
          if (lr.x1 < bx1) bx1 = lr.x1; if (lr.y1 < by1) by1 = lr.y1;
          if (lr.x2 > bx2) bx2 = lr.x2; if (lr.y2 > by2) by2 = lr.y2;
        }
        zones[id] = { x1: bx1, y1: by1, x2: bx2, y2: by2 };
      }

      const isCorridor = z => corridor[z] === true;

      /* spatial room-seal: a room holding a SEALING airlock (closed|jammed) gets NO boundary doors
         below, so canStep can't cross its edge — the agent's BODY is sealed in, like an unmerged branch
         (floor containment only, not capability isolation). The
         trunk room (the integration hub) never seals, so the station can't be severed from its core. */
      const sealed = new Set();
      for (const p of doc.props) {
        if (p.t !== 'airlock' || !doorSeals(p.door)) continue;
        const rid = roomAt(p.x, p.y);
        if (rid && rid !== doc.meta.trunkRoomId) sealed.add(rid);
      }

      /* auto-doors: open a threshold wherever two different zones are orthogonally adjacent,
         so abutting rooms/corridors connect with no manual door tool (foundation default). A seam is
         skipped when either side's room is sealed — that absence is exactly what isolates the room. */
      const doorDefs = [];
      const doorSet = new Set();
      const addDoor = (x1, y1, x2, y2) => {
        const k = x1 + ',' + y1 + '>' + x2 + ',' + y2;
        if (doorSet.has(k)) return;
        doorDefs.push([x1, y1, x2, y2]);
        doorSet.add(k); doorSet.add(x2 + ',' + y2 + '>' + x1 + ',' + y1);
      };
      const linkable = (a, b) => b != null && b !== a && !sealed.has(a) && !sealed.has(b);
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const z = zoneGrid[idx(x, y)];
        if (z == null) continue;
        if (x + 1 < COLS) { const nz = zoneGrid[idx(x + 1, y)]; if (linkable(z, nz)) addDoor(x, y, x + 1, y); }
        if (y + 1 < ROWS) { const nz = zoneGrid[idx(x, y + 1)]; if (linkable(z, nz)) addDoor(x, y, x, y + 1); }
      }

      const canStep = (x1, y1, x2, y2) => {
        if (x2 < 0 || y2 < 0 || x2 >= COLS || y2 >= ROWS) return false;
        const za = zoneGrid[idx(x1, y1)], zb = zoneGrid[idx(x2, y2)];
        if (zb == null) return false;
        if (za === zb) return true;
        return doorSet.has(x1 + ',' + y1 + '>' + x2 + ',' + y2);
      };

      /* chamfers: round the convex, void-exposed corners. A corner is roundable when both of its
         orthogonal-outward neighbours are void.

         HALLWAYS GET THE ART, NOT THE BLOCK (2026-08-10). This ran for ROOMS ONLY — "corridors stay
         slim" — and that is the whole of the broken hallway corner Andrew circled: with no chamfer,
         a hallway's convex corner is a raw right angle where the tall north face (extruded up-screen
         by WALL.corUp) collides with the side band (a top surface at floor level), and nothing
         reconciles the step between them. A room never shows it because a room gets rounded. It also
         explains why the corner tracked the 08-08 wall lane exactly: the step IS corUp tall, so
         raising it 8→12 turned a nick into a block.

         But the exclusion was not arbitrary and must not simply be deleted: a chamfer tile is also
         an UNWALKABLE tile, and hallways are narrow. MIN_HALL allows 2 wide, so blocking both
         corners of a 2-wide end row severs the hallway there — and a 2x2 hallway (Andrew has one
         joining r3 to r1) would have all four corners blocked and become an impassable hole in the
         station's connectivity. Measured, not feared: with the block left in, a 2x2 hallway comes
         back with 2 of its 4 tiles walkable. Pathing would have broken silently on existing saves.

         So the two meanings of "chamfer" are separated, because they were only ever conflated:
           · `chamfers`     — ART. What the bake rounds. Rooms AND corridors.
           · `chamferBlock` — WALKABILITY. What stops being floor. Rooms only, exactly as before.
         Corridor walkability is therefore identical to before this change; only the shell, the crown
         ring and the corner's wall art move. Locked by worldmodel.test.js. */
      const chamfers = [], chamferBlock = [];
      const isVoid = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? true : zoneGrid[idx(x, y)] == null;
      for (const id of doc.order) {
        const rm = doc.rooms[id];
        const isCor = rm.kind === 'corridor';
        const cut = (x, y, kind) => { chamfers.push([x, y, kind]); if (!isCor) chamferBlock.push([x, y]); };
        for (const r of rm.rects) {
          const lx1 = r.x1 - ox, ly1 = r.y1 - oy, lx2 = r.x2 - ox, ly2 = r.y2 - oy;
          if (isVoid(lx1 - 1, ly1) && isVoid(lx1, ly1 - 1)) cut(lx1, ly1, 'tl');
          if (isVoid(lx2 + 1, ly1) && isVoid(lx2, ly1 - 1)) cut(lx2, ly1, 'tr');
          if (isVoid(lx1 - 1, ly2) && isVoid(lx1, ly2 + 1)) cut(lx1, ly2, 'bl');
          if (isVoid(lx2 + 1, ly2) && isVoid(lx2, ly2 + 1)) cut(lx2, ly2, 'br');
        }
      }

      const styleBase = sid => (FLOOR_STYLES[sid] || FLOOR_STYLES.hull).base;
      const baseColorOf = (id, lx, ly) => {
        const rm = doc.rooms[id];
        if (!rm) return styleBase('hull');
        const ov = rm.floorPaint && rm.floorPaint[(lx + ox) + ',' + (ly + oy)];
        return styleBase(ov || rm.floorStyle);
      };

      /* ---------- walkability + pathfinding (local tile frame; pure) ----------
         A tile is walkable if it belongs to a zone, isn't a rounded-corner (chamfer)
         tile, and isn't in the caller's `extra` blocked set (furniture/desks live in
         the renderer, not the model, so they're passed in per query). path() is a BFS
         that only crosses zone seams where canStep allows (same zone or a door). */
      const blockedTiles = new Set();
      // chamferBlock, NOT chamfers — a hallway's corner is rounded in ART but stays walkable, or a
      // 2-wide hall loses its end row and a 2x2 hall becomes an impassable hole. See the split above.
      for (const c of chamferBlock) blockedTiles.add(c[0] + ',' + c[1]);
      // props occupy their footprint: shift to the local frame, block walking, and emit for the
      // renderer. This is the seam the walkability contract promised — furniture lives here now.
      const propsLocal = [];
      for (const p of doc.props) {
        const lx = p.x - ox, ly = p.y - oy, w = p.w || 1, h = p.h || 1;
        const lp = { id: p.id, t: p.t, x: lx, y: ly, w, h, block: p.block !== false, agentId: p.agentId || null };
        if (p.r) lp.r = p.r; if (p.m) lp.m = 1;   // orientation -> PropSprites.draw (turned/flipped art) + PropAnchor (which side is its front); w,h above are already the effective box
        if (p.role) lp.role = p.role;   // a role-carrying dock's placard/nag copy (guided workflows)
        // a bound bay's CAPABILITY room (desk room first, else this bay's room) -> the compiler's SPLIT_CREW advice
        if (p.t === 'bay' && p.agentId) { const cr = agentRoomId(p.agentId, p.id); if (cr) lp.capRoom = cr; }
        if (p.brief) lp.brief = p.brief;   // a dock's standing job brief -> the compiled plan (step editor; prompt text only)
        if (p.hands) lp.hands = p.hands;   // a dock's HANDS OFF phrase -> composed into that brief by the compiler (workflow panel)
        if (p.label) lp.label = p.label;   // an INTAKE's line name (step editor; legibility only, never routing)
        if (p.t === 'intake' && p.projectRoot) lp.projectRoot = p.projectRoot;
        if (p.limits) lp.limits = p.limits;   // an INTAKE's LINE BUDGET -> the compiled plan (pipeline normalizes; chain executor reads)
        if (p.routes) lp.routes = p.routes; if (p.def) lp.def = p.def; if (p.bufferSize) lp.bufferSize = p.bufferSize;   // junction config -> the bake/pipeline
        if (p.timeoutMin) lp.timeoutMin = p.timeoutMin; if (p.maxIter) lp.maxIter = p.maxIter; if (p.done) lp.done = p.done; if (p.when) lp.when = p.when;   // joiner / loop gate config
        if (p.door) lp.door = p.door;   // an AIRLOCK's seal state -> the prop sprite's status light / jam spark
        if (p.connectorId) lp.connectorId = p.connectorId;   // a CONNECTOR PORTAL's bound server -> live state + firing pulse on the sprite
        if (p.pluginId) lp.pluginId = p.pluginId;            // a PLUGIN TERMINAL's bound plugin -> the click opens that plugin's window
        propsLocal.push(lp);
        if (p.block === false) continue;   // flat decor (rugs / wall panels) never blocks walking
        for (let yy = ly; yy < ly + h; yy++) for (let xx = lx; xx < lx + w; xx++) blockedTiles.add(xx + ',' + yy);
      }
      // belts: shift into the local frame for the renderer/transport. Belts are WALKABLE — they
      // are never added to blockedTiles (floor machinery; boxes ride above, agents step across).
      const beltsLocal = [];
      for (const k in doc.belts) { const p = k.split(','); beltsLocal.push({ x: +p[0] - ox, y: +p[1] - oy, dir: doc.belts[k] }); }
      // the floor's LINKS, shifted the same way — the compiler reads hookups and FILTER / LOOP ports from them (absent when
      // the floor's links could not be adopted: the compiler then keeps the ring rule, exactly as before links existed)
      const lk = currentLinks();
      const linksLocal = lk ? lk.map(l => { const o = { id: l.id, from: l.from, to: l.to, path: l.path.map(t => ({ x: t.x - ox, y: t.y - oy, d: t.d })) }; if (l.ring) o.ring = true; return o; }) : null;
      const walkable = (lx, ly, extra) => {
        if (lx < 0 || ly < 0 || lx >= COLS || ly >= ROWS) return false;
        if (zoneGrid[idx(lx, ly)] == null) return false;
        const k = lx + ',' + ly;
        return !blockedTiles.has(k) && !(extra && extra.has(k));
      };
      /* ---------- path smoothing (string-pulling) ----------
         path() is a 4-NEIGHBOUR BFS, so its raw output is a staircase of orthogonal tile hops: a body
         following it pivots 90° at nearly every tile and never once moves diagonally. We pull the string —
         from the current anchor, keep the FARTHEST later waypoint with clear line of sight and drop
         everything between — which collapses the staircase into long straight runs and true diagonals.
         losClear is deliberately conservative. It walks the segment one tile at a time; every touched tile
         must be walkable; every orthogonal hop must satisfy canStep (so a shortcut can NEVER skip a zone
         seam that a door is meant to gate); and an exact diagonal step demands BOTH corner tiles plus the
         canStep legality of both ways around — so a shortcut can't squeeze a body through the diagonal gap
         between two blockers. canStep is orthogonal-only, so it is never called on a diagonal pair. */
      // Validate both the logical tile-centre route and the rendered foot route.
      // world.js footOf uses (x + .5, y + 1 - 1/TILE), so a centre-only
      // shortcut can cross a wall beside a doorway even when its BFS is legal.
      // The visible wall face occupies part of an otherwise walkable edge tile.
      // A foot may enter through an open north doorway, but may only turn beside
      // it after clearing the 9px wall face (5px in corridors). Keep this finer
      // clearance separate from floor occupancy so existing narrow halls survive.
      const wallClearance = new Uint8Array(COLS * ROWS);
      for(let y=0;y<ROWS;y++)for(let x=0;x<COLS;x++){
        if(zoneGrid[idx(x,y)]==null)continue;
        wallClearance[idx(x,y)]=(!canStep(x,y,x,y-1)?1:0)|(!canStep(x,y,x-1,y)?2:0)|(!canStep(x,y,x+1,y)?4:0);
      }
      // The raised doorway returns occupy the corridor ABOVE the room seam.
      // Keep a sprite-width lane through that silhouette, not just a legal foot
      // tile. In a two-tile hall the anchors move inward; no floor tile is removed.
      const mouthLanes = [];
      const wallUp = Number.isFinite(walls.up) ? Math.max(0, Math.round(walls.up)) : 30;
      const capH = Number.isFinite(walls.capH) ? Math.max(2, Math.round(walls.capH)) : 4;
      const at = (x,y) => x<0||y<0||x>=COLS||y>=ROWS ? null : zoneGrid[idx(x,y)];
      const seam = (x,y) => {
        const a=at(x,y-1),b=at(x,y);
        return a===b ? 0 : a==null||b==null ? 2 : canStep(x,y-1,x,y) ? 1 : 2;
      };
      if (wallUp >= 4) for(let y=1;y<ROWS;y++) for(let x=0;x<COLS;x++) {
        if(seam(x,y)!==1)continue;
        let end=x;while(end+1<COLS&&seam(end+1,y)===1)end++;
        let left=0,right=0;
        for(let c=x-1;c>=0&&seam(c,y)===2;c--)left++;
        for(let c=end+1;c<COLS&&seam(c,y)===2;c++)right++;
        // Same architectural doorway rule as StationBake.classifyJoins.
        if(left&&right&&end-x+1<left+right)for(let a=x;a<=end;a++) {
          const room=at(a,y);
          if(isCorridor(room)||!isCorridor(at(a,y-1)))continue;
          let b=a;while(b<end&&at(b+1,y)===room&&isCorridor(at(b+1,y-1)))b++;
          const x0=a*TILE,x1=(b+1)*TILE;
          const reach=Math.min(6,Math.max(1,Math.floor((x1-x0-8)/2)));
          const inset=Math.min((x1-x0)/2-.5,reach+1+4.5);
          mouthLanes.push({x0,x1,top:y*TILE-wallUp-capH,bottom:y*TILE+10,left:x0+inset,right:x1-inset});
          a=b;
        }
        x=end;
      }
      function footPoint(x,y) {
        let px=x*TILE+TILE/2;const py=y*TILE+TILE-1;
        for(const m of mouthLanes)if(px>=m.x0&&px<m.x1&&py>=m.top-TILE&&py<=m.bottom+TILE)
          px=Math.max(m.left,Math.min(m.right,px));
        return {x:px,y:py};
      }
      function clearMouths(ax,ay,bx,by) {
        for(const m of mouthLanes) {
          let lo=0,hi=1;
          const dy=by-ay;
          if(Math.abs(dy)<1e-10){if(ay<m.top||ay>m.bottom)continue;}
          else {const a=(m.top-ay)/dy,b=(m.bottom-ay)/dy;lo=Math.max(0,Math.min(a,b));hi=Math.min(1,Math.max(a,b));if(lo>hi)continue;}
          const a=ax+(bx-ax)*lo,b=ax+(bx-ax)*hi;
          // Only this opening owns the interval. Its shoulders are already
          // rejected by the tile/face checks below.
          if(Math.max(a,b)<m.x0||Math.min(a,b)>m.x1)continue;
          if(Math.min(a,b)<m.left-1e-8||Math.max(a,b)>m.right+1e-8)return false;
        }
        return true;
      }
      function segmentClear(ax, ay, bx, by, extra, physical = false) {
        if (![ax, ay, bx, by].every(Number.isFinite)) return false;
        if (physical && !clearMouths(ax*TILE, ay*TILE, bx*TILE, by*TILE)) return false;
        const x0 = Math.floor(ax), y0 = Math.floor(ay), x1 = Math.floor(bx), y1 = Math.floor(by);
        let x = x0, y = y0;
        const dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
        const xi = bx > ax ? 1 : -1, yi = by > ay ? 1 : -1;
        const stepX = dx ? 1 / dx : Infinity, stepY = dy ? 1 / dy : Infinity;
        let nextX = dx ? (xi > 0 ? x + 1 - ax : ax - x) / dx : Infinity;
        let nextY = dy ? (yi > 0 ? y + 1 - ay : ay - y) / dy : Infinity;
        let entered=0;
        const clearFace=(x,y,from,to)=>{
          if(!physical)return true;
          const flags=wallClearance[idx(x,y)];if(!flags)return true;
          const cor=isCorridor(zoneGrid[idx(x,y)]),side=((cor?2:4)+.5)/TILE,north=((cor?5:9)+.5)/TILE;
          const xa=ax+(bx-ax)*from-x,xb=ax+(bx-ax)*to-x,ya=ay+(by-ay)*from-y,yb=ay+(by-ay)*to-y;
          return (!(flags&1)||Math.min(ya,yb)>=north-1e-8)
            && (!(flags&2)||Math.min(xa,xb)>=side-1e-8)
            && (!(flags&4)||Math.max(xa,xb)<=1-side+1e-8);
        };
        let guard = Math.abs(x1 - x0) + Math.abs(y1 - y0) + 1;
        while ((x !== x1 || y !== y1) && guard-- > 0) {
          if (!walkable(x, y, extra)) return false;
          const leaving=Math.min(1,nextX,nextY);
          if(!clearFace(x,y,entered,leaving))return false;
          entered=leaving;
          if (nextX < nextY - 1e-10) {
            if (!walkable(x + xi, y, extra) || !canStep(x, y, x + xi, y)) return false;
            x += xi; nextX += stepX;
          } else if (nextY < nextX - 1e-10) {
            if (!walkable(x, y + yi, extra) || !canStep(x, y, x, y + yi)) return false;
            y += yi; nextY += stepY;
          } else {
            // At a grid corner both orthogonal passages must be open.
            if (!walkable(x + xi, y, extra) || !walkable(x, y + yi, extra)) return false;
            if (!canStep(x, y, x + xi, y) || !canStep(x, y, x, y + yi)) return false;
            if (!canStep(x + xi, y, x + xi, y + yi) || !canStep(x, y + yi, x + xi, y + yi)) return false;
            x += xi; y += yi; nextX += stepX; nextY += stepY;
          }
        }
        return guard > 0 && walkable(x1, y1, extra) && clearFace(x1,y1,entered,1);
      }
      function losClear(x0, y0, x1, y1, extra) {
        const a=footPoint(x0,y0),b=footPoint(x1,y1);
        return segmentClear(x0 + .5, y0 + .5, x1 + .5, y1 + .5, extra)
          && segmentClear(a.x/TILE,a.y/TILE,b.x/TILE,b.y/TILE,extra,true);
      }
      // Pixel-space companion for actual starts, corner lookahead and body nudges.
      const clearFootSegment = (ax, ay, bx, by, extra) => segmentClear(ax / TILE, ay / TILE, bx / TILE, by / TILE, extra, true);
      function smoothPath(pts, sx, sy, extra) {
        if (!pts || pts.length < 3) return pts;
        const out = [];
        let ax = sx, ay = sy, i = 0;
        while (i < pts.length) {
          let best = i;
          for (let j = pts.length - 1; j > i; j--) {
            if (losClear(ax, ay, pts[j].x, pts[j].y, extra)) { best = j; break; }
          }
          out.push(pts[best]);
          ax = pts[best].x; ay = pts[best].y;
          i = best + 1;
        }
        return out;
      }
      function path(sx, sy, tx, ty, extra) {
        if (!walkable(tx, ty, extra)) return null;
        if (sx === tx && sy === ty) return [];
        const prev = new Int32Array(COLS * ROWS).fill(-1);
        const start = idx(sx, sy), target = idx(tx, ty);
        prev[start] = start;
        const q = [start]; let head = 0;
        while (head < q.length) {
          const cur = q[head++];
          if (cur === target) break;
          const cx = cur % COLS, cy = (cur / COLS) | 0;
          for (let d = 0; d < 4; d++) {
            const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
            const ni = idx(nx, ny);
            if (prev[ni] !== -1 || !walkable(nx, ny, extra) || !canStep(cx, cy, nx, ny)) continue;
            const a=footPoint(cx,cy),b=footPoint(nx,ny);
            if(!clearFootSegment(a.x,a.y,b.x,b.y,extra))continue;
            prev[ni] = cur; q.push(ni);
          }
        }
        if (prev[target] === -1) return null;
        const out = []; let cur = target;
        while (cur !== start) { out.push({ x: cur % COLS, y: (cur / COLS) | 0 }); cur = prev[cur]; }
        out.reverse();
        return smoothPath(out, sx, sy, extra);   // collapse the BFS staircase into straight runs + diagonals
      }

      return {
        TILE, COLS, ROWS, W: COLS * TILE, H: ROWS * TILE + HULL_PAD,
        origin: { tx: ox, ty: oy },
        allRects, zones, ROOM_IDS, isCorridor, chamfers, windows: [], props: propsLocal, belts: beltsLocal, ...(linksLocal ? { links: linksLocal } : {}),
        doorDefs, zoneGrid, idx, canStep, baseColorOf, walkable, path, clearFootSegment, footPoint, blockedTiles,
        nameOf: id => (doc.rooms[id] ? doc.rooms[id].name : ''),
        kindOf: id => (doc.rooms[id] ? doc.rooms[id].kind : null),
        matOf: id => matOfRoom(doc.rooms[id]),   // effective deck material (override, else kind default)
        // walls: effective material, and the base colour to derive the wall palette from (a room's
        // own wall hue when set, else its floor hue — so walls harmonize with the deck by default)
        wallMatOf: id => wallMatOfRoom(doc.rooms[id]),
        wallBaseOf: id => styleBase(wallStyleOfRoom(doc.rooms[id])),
        // the exterior shell: effective material, and the hue to derive its palette from. NULL base
        // is meaningful and must be passed through as null — it means "the shell's own tone", which
        // the bake answers with its literal legacy constants rather than a derived ramp.
        hullMatOf: id => hullMatOfRoom(doc.rooms[id]),
        hullBaseOf: id => { const s = hullStyleOfRoom(doc.rooms[id]); return s ? styleBase(s) : null; },
        FLOOR_STYLES, FLOOR_MATERIALS, WALL_MATERIALS, HULL_MATERIALS
      };
    }

    /* ---------- agent-bay binding (Phase B: a belt endpoint named for an agent) ---------- */
    function assignPropAgent(propId, agentId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const aid = String(agentId || '').trim();
      if (aid && !AID_RE.test(aid)) return fail('BAD_AGENT', 'agentId must match ' + AID_RE);
      snapshot();
      if (aid) p.agentId = aid; else delete p.agentId;   // empty string unbinds
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, agentId: aid || null };
    }
    // cycle an AIRLOCK's door state (open|closed|jammed) — the room-seal (merge/staging) handle. Mirrors
    // assignPropAgent. 'open' clears the field (= default) so docs stay clean. A full re-bake (emit []) is
    // used because sealing flips the room's whole wall/threshold boundary, not just the prop's footprint.
    function setDoorState(propId, state) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const s = cleanDoor(state);
      if (!s) return fail('BAD_STATE', 'door state must be open|closed|jammed');
      snapshot();
      if (s === 'open') delete p.door; else p.door = s;
      emit([]);
      return { ok: true, id: propId, door: p.door || 'open' };
    }
    // set/replace a FILTER's routes+def or a MERGER's bufferSize (cfg null/empty clears). Mirrors assignPropAgent.
    /* JOINER <-> MERGER, in place (2026-09-28 — the splitter's COPY TO EACH / TAKE TURNS switch). On the floor they are the
       SAME machine — a 1x1 junction on the belt that several lanes run into and one runs out of — and differ only in what
       they do with a job's parts: a JOINER waits for every branch and sends ONE combined result on (it is what makes the
       split upstream COPY), a MERGER lets each job go on alone (the split TAKES TURNS). Swapping the type keeps the tile,
       every belt and the prop id; the JOINER-only wait limit goes with the JOINER. One undo step. */
    const JOIN_SWAP = { joiner: 'merger', merger: 'joiner' };
    function swapJoinerMerger(propId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const to = JOIN_SWAP[p.t];
      if (!to) return fail('BAD_TYPE', 'only a JOINER and a MERGER swap');
      snapshot();
      p.t = to;
      delete p.timeoutMin;
      emit([propFootprint(p)], { staticBakeUnchanged: true });
      return { ok: true, id: p.id, t: to };
    }
    function configureJunction(propId, cfg) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const linkedNow = Array.isArray(currentLinks());
      snapshot();
      delete p.routes; delete p.def; delete p.bufferSize; delete p.timeoutMin; delete p.maxIter; delete p.done; delete p.when;   // replace wholesale
      if (cfg) applyJunctionCfg(p, cfg);
      // a linked floor: the junction's out-links carry what the new config routes down their lanes (links are what the
      // compiler reads — a route set in the panel must land on the link it names)
      if (linkedNow && isJunction(p)) {
        const lanes = junctionOutLanes(p);
        if (lanes.length) doc.links = doc.links.map(l => { const o = lanes.find(q => q.link === l); return o ? Object.assign({}, l, { from: junctionPort(p, o.dir) }) : l; });
      }
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, routes: p.routes || null, def: p.def || null, bufferSize: p.bufferSize || null, timeoutMin: p.timeoutMin || null, maxIter: p.maxIter || null, done: p.done || null, when: p.when || null };
    }
    // bind/clear the connectorId on a CONNECTOR PORTAL — WHICH MCP server this gateway grants (per-instance).
    // A blank id unbinds (the portal grants nothing until bound; bayObjects emits it only when bound). Mirrors
    // assignPropAgent's shape; the live state/tools come from the sidecar connector manager keyed by this id.
    function bindConnector(propId, connectorId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      snapshot();
      const id = (connectorId == null ? '' : String(connectorId)).trim();
      if (id) p.connectorId = id; else delete p.connectorId;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, connectorId: p.connectorId || null };
    }
    // bind/clear the pluginId on a PLUGIN TERMINAL — WHICH plugin's tools it grants and whose window it opens.
    const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    function bindPlugin(propId, pluginId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (p.t !== 'plugin_terminal') return fail('NOT_A_TERMINAL', 'only a plugin terminal can be bound to a plugin');
      const id = (pluginId == null ? '' : String(pluginId)).trim();
      if (id && !PLUGIN_ID_RE.test(id)) return fail('BAD_PLUGIN', 'that is not a plugin id');
      snapshot();
      if (id) p.pluginId = id; else delete p.pluginId;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, pluginId: p.pluginId || null };
    }
    /* PLACE A PLUGIN'S TERMINAL (install places it — Andrew 2026-09-29): a REAL placed prop, bound to the plugin, in
       the agent's capability room (desk room, then bay room, then the spawn room). Idempotent: an existing terminal
       for this plugin anywhere on the station is returned as-is, never duplicated. Scans the room for the first
       spot the ordinary placement rules accept (walls, doors, walk paths), top rows first so it stands against the
       wall like the other capability props. Fails honestly when the room is full — the caller says so. */
    function placePluginTerminal(pluginId, agentId) {
      const pid = String(pluginId || '').trim();
      if (!PLUGIN_ID_RE.test(pid)) return fail('BAD_PLUGIN', 'that is not a plugin id');
      const existing = doc.props.find(p => p.t === 'plugin_terminal' && p.pluginId === pid);
      if (existing) return { ok: true, existing: true, id: existing.id, x: existing.x, y: existing.y, roomId: roomAt(existing.x, existing.y) };
      const aid = String(agentId || '').trim();
      const desk = aid ? doc.props.find(p => SEAT_WORKSTATIONS[p.t] && p.agentId === aid) : null;
      const roomId = (desk && roomAt(desk.x, desk.y)) || (aid && agentRoomId(aid)) || doc.meta.spawnRoomId;
      const rm = roomId && doc.rooms[roomId];
      if (!rm || !Array.isArray(rm.rects) || !rm.rects.length) return fail('NO_ROOM', 'no room to place the terminal in');
      for (const r of rm.rects) {
        const midX = Math.floor((r.x1 + r.x2) / 2);
        const cols = [];
        for (let d = 0; d <= r.x2 - r.x1; d++) { if (midX + d <= r.x2) cols.push(midX + d); if (d && midX - d >= r.x1) cols.push(midX - d); }
        for (let y = r.y1; y <= r.y2 - 1; y++) {
          for (const x of cols) {
            if (!canPlaceProp('plugin_terminal', x, y, 1, 2).ok) continue;
            const added = addProp({ t: 'plugin_terminal', x, y, w: 1, h: 2 });
            if (!added.ok) continue;
            const p = doc.props.find(q => q.id === added.id);
            p.pluginId = pid;
            emit([{ x1: x, y1: y, x2: x, y2: y + 1 }]);
            return { ok: true, id: added.id, x, y, roomId };
          }
        }
      }
      return fail('ROOM_FULL', 'no free spot for a terminal in that room');
    }
    /* set/clear a BAY's standing JOB BRIEF (step editor, 2026-08-05) — what this step does with arriving
       work. PROMPT TEXT ONLY: it rides the compiled plan into run prompts and never changes who runs or
       what tools they hold. Mirrors assignPropAgent's shape; empty clears; bounded at 2000 chars (the
       same cap migrate()/the compiler enforce, so no path can smuggle an unbounded blob into a save). */
    // a BAY's ROLE — the step's name on its line (RESEARCHER, WRITER, …): one of BAY_ROLES, or none (the Workflow panel's ROLE
    // chips, conveyor-links phase D). No change, no undo slot.
    function setPropRole(propId, role) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (p.t !== 'bay') return fail('BAD_TYPE', 'only a BAY has a role');
      const r = (typeof role === 'string' && BAY_ROLES[role]) ? role : null;
      if ((p.role || null) === r) return { ok: true, id: propId, role: r };
      snapshot();
      if (r) p.role = r; else delete p.role;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, role: r };
    }
    function setPropBrief(propId, brief) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (p.t !== 'bay') return fail('BAD_TYPE', 'only a BAY carries a job brief');
      const b = (brief == null ? '' : String(brief)).trim().slice(0, 2000);
      if ((p.brief || '') === b || (!p.brief && !b)) return { ok: true, id: propId, brief: p.brief || null };   // no-op: no undo slot, no re-emit
      snapshot();
      if (b) p.brief = b; else delete p.brief;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, brief: p.brief || null };
    }
    /* set/clear a BAY's HANDS OFF phrase (workflow panel, 2026-09-22) — the short "what this step hands to the
       next one" (e.g. "a 200-word draft"). NOT cosmetic: Pipeline.composeStageBrief folds it into the brief the
       agent receives ("When you're done, hand off: …"). Prompt text only, like the brief. Bounded at 160. */
    function setPropHands(propId, hands) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (p.t !== 'bay') return fail('BAD_TYPE', 'only a BAY hands work off');
      const h = (hands == null ? '' : String(hands)).replace(/\s+/g, ' ').trim().slice(0, 160);
      if ((p.hands || '') === h || (!p.hands && !h)) return { ok: true, id: propId, hands: p.hands || null };
      snapshot();
      if (h) p.hands = h; else delete p.hands;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, hands: p.hands || null };
    }
    // set/clear an INTAKE's line name (step editor) — pure legibility (the finish-the-line header + the
    // intake glance); routing never reads it. Mirrors setPropBrief; bounded at 48 chars like migrate().
    function setPropLabel(propId, label) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (p.t !== 'intake') return fail('BAD_TYPE', 'only an INBOX names its line');
      const l = (label == null ? '' : String(label)).trim().slice(0, 48);
      if ((p.label || '') === l || (!p.label && !l)) return { ok: true, id: propId, label: p.label || null };
      snapshot();
      if (l) p.label = l; else delete p.label;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, label: p.label || null };
    }
    function setPropProject(propId, projectRoot) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (p.t !== 'intake') return fail('BAD_TYPE', 'only an INBOX carries a project');
      const root = typeof projectRoot === 'string' ? projectRoot.trim().slice(0, 4096) : '';
      // Every Inbox in one connected workflow shares the setting and one undo step.
      const P = pipelineModule();
      const line = P && P.lineComponents(projectGeometry()).find(c => c.intakes.includes(propId));
      const targets = doc.props.filter(q => q.t === 'intake' && (line ? line.intakes.includes(q.id) : q.id === propId));
      if (targets.every(q => (q.projectRoot || '') === root)) return { ok: true, projectRoot: root };
      snapshot();
      for (const q of targets) { if (root) q.projectRoot = root; else delete q.projectRoot; }
      emit(targets.map(q => ({ x1: q.x, y1: q.y, x2: q.x + (q.w || 1) - 1, y2: q.y + (q.h || 1) - 1 })));
      return { ok: true, projectRoot: root };
    }
    /* set/clear an INTAKE's LINE BUDGET (REFIT flow card, 2026-08-21): { maxHops, maxUsdPerMessage, maxUsdPerDay }.
       Normalized + clamped through the ONE shared normalizer (Pipeline.normalizeLineLimits) so the doc never
       holds a number the executor would read differently; null/empty clears (= executor defaults). Mirrors
       setPropLabel: only an INBOX carries it, no-op edits take no undo slot. */
    function setPropLimits(propId, limits) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (p.t !== 'intake') return fail('BAD_TYPE', 'only an INBOX carries a line budget');
      const norm = normalizeLimits(limits);
      const next = norm ? { maxHops: norm.maxHops, maxUsdPerMessage: norm.maxUsdPerMessage, maxUsdPerDay: norm.maxUsdPerDay } : null;
      const same = JSON.stringify(p.limits || null) === JSON.stringify(next);
      if (same) return { ok: true, id: propId, limits: p.limits || null, clamped: (norm && norm.clamped) || [] };
      snapshot();
      if (next) p.limits = next; else delete p.limits;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, limits: p.limits || null, clamped: (norm && norm.clamped) || [] };
    }
    const propsByType = t => doc.props.filter(p => p.t === t).map(clone);
    const propsByAgent = agentId => doc.props.filter(p => p.agentId === agentId).map(clone);
    const pipelineEdges = () => clone(doc.edges || []);
    function setPipelineEdges(edges) {
      const clean = [];
      const seen = {};
      for (const e of (Array.isArray(edges) ? edges : [])) {
        const ce = cleanPipelineEdge(e);
        if (!ce) continue;
        const k = ce.from + '>' + ce.to + ':' + ce.whenKind + ':' + (ce.lane || '');
        if (seen[k]) continue;
        seen[k] = true; clean.push(ce);
      }
      if (JSON.stringify(clean) === JSON.stringify(doc.edges || [])) return { ok: true, count: clean.length };
      snapshot();
      doc.edges = clean;
      emit([]);
      return { ok: true, count: clean.length };
    }
    function addPipelineEdge(edge) {
      const ce = cleanPipelineEdge(edge);
      if (!ce) return fail('BAD_EDGE', 'edge must be {from,to,whenKind,lane?}');
      return setPipelineEdges((doc.edges || []).concat([ce]));
    }
    function removePipelineEdge(edge) {
      const ce = cleanPipelineEdge(edge);
      if (!ce) return fail('BAD_EDGE', 'edge must be {from,to,whenKind,lane?}');
      const before = doc.edges || [];
      const next = before.filter(e => !(e.from === ce.from && e.to === ce.to && e.whenKind === ce.whenKind && (e.lane || '') === (ce.lane || '')));
      if (next.length === before.length) return fail('NOT_FOUND', 'no such edge');
      snapshot();
      doc.edges = next;
      emit([]);
      return { ok: true, count: next.length };
    }
    /* The agent's CAPABILITY room — the capability-isolation seam. REMOTE-BAY RULING (2026-08-14, Andrew):
       a bay is a REMOTE TRIGGER, placeable anywhere on the station — it fires the run and the crate physics,
       but the agent's toolbox lives where its DESK is. So: still gated on OWNING a bay (a bayless agent keeps
       its legacy scope — hero station-wide, summoned worker lead-conferred), but the room resolved is the
       agent's own SEAT_WORKSTATIONS desk room first, falling back to the bay's room only when the agent has
       no desk (a desk-less bay behaves byte-for-byte as before). */
    /* MULTI-BAY (2026-09-22 — Andrew's ruling): an agent may crew several bays. `dockId` names the bay THIS run
       is at: a deskful agent still resolves its desk room (the remote-bay ruling holds on every bay), a desk-less
       one gets the room of THAT bay — never the union of its bays' rooms. No dockId = its first bay (the
       pre-multi-bay reading; the router passes the entry dock whenever it knows one). */
    function agentRoomId(agentId, dockId) {
      const bay = (dockId != null && doc.props.find(p => p.t === 'bay' && p.agentId === agentId && p.id === dockId))
        || doc.props.find(p => p.t === 'bay' && p.agentId === agentId);
      if (!bay) return null;
      const desk = doc.props.find(p => SEAT_WORKSTATIONS[p.t] && p.agentId === agentId);
      if (desk) { const r = roomAt(desk.x, desk.y); if (r) return r; }
      return roomAt(bay.x, bay.y);
    }
    // Phase B5: the capability objectTypes (CAP_REGISTRY) granted by the cap-props sharing the agent's
    // CAPABILITY room (agentRoomId — desk room first, bay room as fallback; see the remote-bay ruling above) —
    // exactly what the sidecar feeds resolveTools, so each agent's tools are what you placed in its room. Deduped.
    // PER-AGENT PC (the true rule): COMPUTE is granted by a computer prop DEDICATED to this agent — one BOUND to
    // it (agentId match), or (back-compat) an UNBOUND computer when the room holds a single agent. So a SHARED
    // room (3-4 agents passing work) demands a distinct PC per agent, while a solo room still runs unbound. Every
    // OTHER cap (cabinet/dish/notebook/connector) stays room-based — a shared room's files/web/memory are shared.
    function bayObjects(agentId, dockId) {
      const room = agentRoomId(agentId, dockId);
      if (!room) return [];
      // solo = ONE agent resolves its capability room here (remote bays mean the occupant census must count
      // agents by their CAPABILITY room, not by which room their bay prop happens to stand in). Per BAY
      // (multi-bay): an agent counts in every room one of its bays resolves to.
      const owners = {};
      for (const p of doc.props) if (p.t === 'bay' && p.agentId && agentRoomId(p.agentId, p.id) === room) owners[p.agentId] = true;
      const soloRoom = Object.keys(owners).length <= 1;   // one agent in the room -> an unbound PC is unambiguously this agent's
      const seen = {}, out = [];
      for (const p of doc.props) {
        const cap = CAP_PROP_MAP[p.t];
        if (!cap) continue;
        if (roomAt(p.x, p.y) !== room) continue;
        if (cap === 'computer') {
          if (!(p.agentId === agentId || (!p.agentId && soloRoom))) continue;   // not THIS agent's dedicated PC
          if (seen.computer) continue;
          seen.computer = true; out.push('computer');
          continue;
        }
        if (cap === 'connector') {
          // per-instance, NOT deduped: each BOUND connector portal grants its OWN server's tools. The sidecar
          // reads { objectType, connectorId } (router.stationFor passes the object through; resolveTools yields
          // no static grant — the MCP tools are projected dynamically by the connector manager). An UNBOUND
          // portal (no connectorId) grants nothing until the Commander binds it.
          if (p.connectorId) out.push({ objectType: 'connector', connectorId: p.connectorId });
          continue;
        }
        if (cap === 'plugin') {
          // same per-instance rule: a BOUND plugin terminal grants THAT plugin's tools (the sidecar projects them
          // from the plugin's process, only while its approval covers its code); an unbound one grants nothing.
          if (p.pluginId) out.push({ objectType: 'plugin', pluginId: p.pluginId });
          continue;
        }
        if (seen[cap]) continue;
        seen[cap] = true; out.push(cap);
      }
      return out;
    }

    /* THE OVERSEER'S DESK, MADE REAL. Historically the hero's starter desk was a SYNTHETIC render in
       world.js — drawn and walk-blocking, but absent from doc.props. That was an object=capability lie
       with real teeth: bayObjects() truthfully found no computer in the room, so a bay placed beside the
       visible "PC" nagged NO COMPUTE and the belt system looked broken on every fresh install (2026-07-05
       playtest bug). This materializes the same desk as a REAL placed workstation prop assigned to the
       agent, at the exact spot the synthetic one drew (spawn room, mid-width on the north wall), keeping
       the old invariant — the overseer always has a desk — honestly. Idempotent: no-op when the agent
       already owns any seat-type workstation. Falls back to the nearest valid spawn-room tile if the
       canonical spot is occupied; callers may still synthesize when even that fails (crowded floor). */
    const SEAT_WORKSTATIONS = { desk: 1, desk2: 1, console: 1, consoleL: 1, pixelrig: 1, bench: 1 };
    // Is there anywhere to put the CHAIR? world.js seats a body on the tile row directly SOUTH of a
    // workstation (PropAnchor's 'south' approach), so a desk whose whole south row is wall or blocking
    // prop is a desk nobody can sit at. Pure geometry — the model still knows nothing about chairs.
    function deskSeatFree(x, y, w) {
      const sy = y + 1;
      for (let sx = x; sx < x + w; sx++) {
        if (!roomAt(sx, sy)) continue;
        const pid = propAt(sx, sy);
        if (pid) { const p = propById(pid); if (p && p.block !== false) continue; }
        return true;
      }
      return false;
    }
    // Scan one room rect for a 2x1 desk spot, preferring one with a free seat row below it. Returns the
    // seat-approachable spot when there is one, else the first merely-valid spot, else null. Rows are walked
    // from y1+1 — the hero's own desk row — so a bank of seeded crew desks lines up WITH the starter desk
    // instead of tucking under the north wall face the tall-walls bake raises along y1. y1 stays as a last
    // resort (it is legal deck the Commander can build on) rather than being ruled out.
    function deskSpotIn(r) {
      let any = null;
      const rows = [];
      for (let y = r.y1 + 1; y <= r.y2; y++) rows.push(y);
      rows.push(r.y1);
      for (const y of rows)
        for (let x = r.x1; x <= r.x2; x++) {
          if (!canPlaceProp('desk', x, y, 2, 1).ok) continue;
          if (deskSeatFree(x, y, 2)) return { x, y };
          if (!any) any = { x, y };
        }
      return any;
    }
    function ensureWorkstation(agentId) {
      const aid = String(agentId || '').trim();
      if (!aid || !AID_RE.test(aid)) return fail('BAD_AGENT');
      const own = doc.props.find(p => SEAT_WORKSTATIONS[p.t] && p.agentId === aid);
      if (own) return { ok: true, existing: true, id: own.id, agentId: aid, x: own.x, y: own.y, roomId: roomAt(own.x, own.y) };
      // ADOPT BEFORE BUILDING. An UNBOUND workstation is dead furniture — no agent may walk to an unassigned
      // capability prop (world.js mayTouchProp), so it grants nobody a seat. Two ways one appears: the Commander
      // built a desk and never bound it, and deleteAgent unbinds (never demolishes) the props of a removed
      // specialist. Without this, a summon → delete → summon cycle silently litters the spawn room with
      // abandoned desks and eventually pushes the seeder into other rooms. Deliberately SPAWN-ROOM ONLY: a
      // free desk the Commander built in some far lab is theirs to assign, and adopting it would land a
      // newly-summoned specialist (and its whole zone/leash) somewhere they never asked for.
      const adopt = doc.props.find(p => SEAT_WORKSTATIONS[p.t] && !p.agentId && roomAt(p.x, p.y) === doc.meta.spawnRoomId);
      if (adopt) {
        const bound = assignPropAgent(adopt.id, aid);
        return bound.ok ? Object.assign({}, bound, { adopted: true, x: adopt.x, y: adopt.y, roomId: roomAt(adopt.x, adopt.y) }) : bound;
      }
      const rm = doc.meta.spawnRoomId && doc.rooms[doc.meta.spawnRoomId];
      const r = rm && rm.rects && rm.rects[0];
      if (!r) return fail('NO_SPAWN_ROOM');
      // the synthetic auto-desk's exact spot (mirrors world.js placeDesk fallback, in world tiles)
      let dtx = r.x1 + Math.max(1, Math.floor((r.x2 - r.x1) / 2));
      if (dtx + 1 > r.x2) dtx = Math.max(r.x1, r.x2 - 1);
      const dty = Math.min(r.y1 + 1, r.y2 - 1);
      let spot = (canPlaceProp('desk', dtx, dty, 2, 1).ok && deskSeatFree(dtx, dty, 2)) ? { x: dtx, y: dty } : null;
      if (!spot) spot = deskSpotIn(r);
      // CREW SEEDING: the spawn room fills up once several summoned specialists each own a desk. A crowded
      // spawn room must not strand the next one deskless while the rest of the station stands empty, so
      // fall through to every OTHER room (spawn room stays first — the hero's seed never moves).
      if (!spot) {
        for (const id of doc.order) {
          if (id === doc.meta.spawnRoomId) continue;
          for (const rect of (doc.rooms[id] && doc.rooms[id].rects) || []) { spot = deskSpotIn(rect); if (spot) break; }
          if (spot) break;
        }
      }
      if (!spot) return fail('NO_ROOM_FOR_DESK');
      const res = addProp({ t: 'desk', x: spot.x, y: spot.y, w: 2, h: 1, block: true });
      if (!res.ok) return res;
      const bound = assignPropAgent(res.id, aid);
      return bound.ok ? Object.assign({}, bound, { x: spot.x, y: spot.y, roomId: roomAt(spot.x, spot.y) }) : bound;
    }
    /* ONE DESK PER AGENT (2026-10-08). world.js seats an agent at the FIRST workstation bound to it (deskPropFor, by
       capForProp === 'computer'), so binding a second one must take the agent off the others — otherwise the binding
       reports success while the agent keeps walking to its old desk. BUILD MODE's WHO SITS HERE chips (build.js) and the
       overseer's station-control 'agent' op (stationbuilder.js) both bind through here: one transaction, one UNDO. A
       non-workstation prop (a bay) binds exactly as assignPropAgent does, and '' empties just this prop. `released`
       names the desks the agent left, so a caller can say so instead of implying nothing else moved. */
    function assignDesk(propId, agentId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const aid = String(agentId || '').trim();
      if (aid && !AID_RE.test(aid)) return fail('BAD_AGENT', 'agentId must match ' + AID_RE);
      const seat = t => CAP_PROP_MAP[t] === 'computer';
      const others = (aid && seat(p.t)) ? doc.props.filter(q => q.id !== propId && q.agentId === aid && seat(q.t)).map(q => q.id) : [];
      const r = others.length ? transact(() => {
        for (const id of others) { const u = assignPropAgent(id, ''); if (!u.ok) return u; }
        return assignPropAgent(propId, aid);
      }) : assignPropAgent(propId, aid);
      return r && r.ok ? Object.assign({}, r, { released: others }) : r;
    }

    /* ---------- serialize / subscribe ---------- */
    const serialize = () => { currentLinks(); return clone(doc); };
    function onChange(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }

    return {
      // reads
      doc: () => doc, rooms, roomById, roomAt, bounds, spawnRoomId,
      props, propById, propAt, belts, beltAt,
      getSeq: () => seq, FLOOR_STYLES, FLOOR_MATERIALS, MAT_ORDER, WALL_MATERIALS, WALL_ORDER, HULL_MATERIALS, HULL_ORDER, ROOM_KINDS, KIND_ORDER, TILE, MIN_ROOM, MIN_HALL,
      matOfRoom: id => matOfRoom(doc.rooms[id]),   // the room's effective deck material (for the palette's active state)
      wallMatOfRoom: id => wallMatOfRoom(doc.rooms[id]),
      wallStyleOfRoom: id => wallStyleOfRoom(doc.rooms[id]),
      hullMatOfRoom: id => hullMatOfRoom(doc.rooms[id]),
      hullStyleOfRoom: id => hullStyleOfRoom(doc.rooms[id]),
      // validation (no mutation — for ghost previews)
      canPlaceRoom, canPlaceHallway, canPlaceProp, canPlaceBeltRun, canPlaceBlueprint, roomSpots,
      // mount rules: injected so the model never imports the prop catalog (see MOUNT RULES).
      // surfaceHostOf is the read surface the world layer uses to decide whether a placed prop is
      // ACTUALLY standing on a table right now — a prop whose table was reclaimed renders back on the
      // deck rather than floating, so no save ever needs migrating.
      // FRAME-PROOF: both readers below re-resolve the prop from the DOC by id before measuring it.
      // A renderer holds whatever frame it draws in — build.js has WORLD props, world.js has the
      // LOCAL ones projectGeometry() emits (same ids, shifted by the hull margin) — and the doc's
      // tables are only ever in WORLD tiles. Measuring the caller's copy compared a local footprint
      // against world footprints, so a station whose origin wasn't (0,0) — i.e. every real one —
      // found no host and the live world silently never lifted a single table-top prop.
      surfaceHostOf: (p) => {
        const host = p ? surfaceHostFor(propFootprint(propById(p.id) || p), p.id) : null;
        return host ? host.id : null;
      },
      // mountOf is the ONE question a renderer asks: "is this prop standing on a table RIGHT NOW?"
      // -> 'surface' | null. It folds both halves — the type may mount at all (mount/stack) AND a host
      // is actually under it — so the live world and the REFIT editor cannot answer it differently.
      // They did: build.js resolved neither half, so every table-top prop drew SURFACE_RISE px low
      // (sunk into its table) and with a sort key tied to the table's, i.e. sometimes behind it too.
      mountOf: (p) => {
        if (!p) return null;
        const rule = ruleOf(p.t);
        if (rule.mount !== 'surface' && !rule.stack) return null;
        return surfaceHostFor(propFootprint(propById(p.id) || p), p.id) ? 'surface' : null;
      },
      // mutations
      addRoom, placeHallway, removeRoom, moveRoom, moveRooms, resizeRoom, setRoomKind, setFloor, setMaterial, setDeck, setWalls, setHull, paintTiles, renameRoom,
      addProp, removeProp, moveProp, moveProps, rotateProp, faceProp, mirrorProp, assignPropAgent, assignDesk, ensureWorkstation, configureJunction, swapJoinerMerger, bindConnector, bindPlugin, placePluginTerminal, setDoorState, setPropProject, setPropBrief, setPropRole, setPropHands, setPropLabel, setPropLimits,
      setBelt, removeBelt, removeBelts, placeBeltRun, connectBelt, connectionPreview, hookedBelts, stampBlueprint, insertBayBetween, canInsertBayBetween, transact, lineGraph, applyLineLayout, blueprintGraph,
      // agent-bay binding queries
      propsByType, propsByAgent, pipelineEdges, setPipelineEdges, addPipelineEdge, removePipelineEdge, agentRoomId, bayObjects,
      capForProp: t => CAP_PROP_MAP[t] || null,   // a prop type's capability objectType (single source for the UI)
      undo, redo, canUndo, canRedo, replaceLayout,
      // projection + io
      projectGeometry, serialize, onChange,
      // the floor's explicit connections (world tiles), or null when not adopted — see LINKS above
      links: () => { const l = currentLinks(); return l ? clone(l) : null; },
      // does this floor build by LINKS (every floor this build adopted)? — REFIT retires the ring-rule advice when it does
      isLinked: () => Array.isArray(currentLinks()),
      previewBelt,
    };
  }

  /* forward-only migration ladder for serialized docs (none yet — v1 is current) */
  function migrate(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    if (!doc.schema) doc.schema = 'starnet.station';
    if (!doc.version) doc.version = 1;
    // v1 -> v2: links are added — derived from the belts on the first read after load (makeStation's link cache), which is
    // the same compile that routes the floor now, and adopted only when they compile to the identical plan
    if (doc.version < 2) doc.version = 2;
    if (doc.links != null && !Array.isArray(doc.links)) doc.links = null;
    // make deserialize TOTAL over any partial/legacy/corrupted v1 blob (it's the persistence seam):
    if (!doc.rooms || typeof doc.rooms !== 'object') doc.rooms = {};
    if (!Array.isArray(doc.order)) doc.order = Object.keys(doc.rooms);
    // drop order entries with no live room object, and repair any room missing a rects[] array —
    // so a truncated / hand-edited save can never crash the read paths (eachRectWorld/bounds/project).
    doc.order = doc.order.filter(id => doc.rooms[id] && typeof doc.rooms[id] === 'object');
    // floorMat is additive (docs predate the material axis): null/unknown means "inherit the kind
    // default", so a legacy blob and a hand-edited one both fall back to the exact pre-material look.
    for (const id of doc.order) {
      const rm = doc.rooms[id];
      if (!Array.isArray(rm.rects)) rm.rects = [];
      if (!rm.floorPaint) rm.floorPaint = {};
      if (!FLOOR_MATERIALS[rm.floorMat]) rm.floorMat = null;
      // Walls are additive too. Every room written before the wall axis carries a literal
      // wallStyle:'hull' that NOTHING ever read — it's noise, not intent, and keeping it would
      // pin every legacy room's walls to hull instead of letting them follow their own floor.
      // The absence of a wallMat key is the reliable tell that a room predates the axis.
      if (!('wallMat' in rm)) rm.wallStyle = null;
      if (!FLOOR_STYLES[rm.wallStyle]) rm.wallStyle = null;
      if (!WALL_MATERIALS[rm.wallMat]) rm.wallMat = null;
      // the hull axis is additive the same way — absent means `station` at the shell's own tone,
      // which is exactly what every pre-axis room already renders as.
      if (!FLOOR_STYLES[rm.hullStyle]) rm.hullStyle = null;
      // Insulation belongs inside. Retire old exterior selections without changing interior walls or explicit paint.
      if (rm.hullMat === 'insulation') rm.hullMat = 'thermal';
      if (!HULL_MATERIALS[rm.hullMat]) rm.hullMat = null;
    }
    // props are additive (v1 docs predate them); make the read paths total over any blob.
    if (!Array.isArray(doc.props)) doc.props = [];
    // legacy repair: the 2×2 workflow docks shipped as block:false for a while, so agents walked
    // straight through them. They are solid now (catalog blocks:true; belts hook to ring tiles,
    // never under the footprint) — strip the stale flag from saved docs so old stations heal on load.
    const LEGACY_WALKABLE_DOCKS = { intake: 1, bay: 1, outbox: 1 };
    // RETIRED PROP TYPES must be dropped, not merely left unpainted. PropSprites.draw() no-ops on an
    // unknown type, but the doc entry keeps its footprint — so a station saved with a since-retired prop
    // would carry an INVISIBLE obstacle that agents path around forever. Only prunes when the mount-rule
    // lookup is installed (i.e. a real client with the catalog); plain node tests keep every prop.
    if (propRules) doc.props = doc.props.filter(p => !(p && typeof p.t === 'string') || !!propRules(p.t));
    doc.props = doc.props.filter(p => p && typeof p === 'object' && typeof p.t === 'string')
      .map(p => { const o = { id: p.id || null, t: p.t, x: p.x | 0, y: p.y | 0, w: Math.max(1, p.w | 0 || 1), h: Math.max(1, p.h | 0 || 1) }; if (p.block === false && !LEGACY_WALKABLE_DOCKS[p.t]) o.block = false; if (typeof p.agentId === 'string' && p.agentId) o.agentId = p.agentId; const r0 = cleanRot(p.r); if (r0) o.r = r0; if (p.m) o.m = 1; if (typeof p.role === 'string' && p.role) o.role = p.role.slice(0, 24); if (typeof p.brief === 'string' && p.brief.trim()) o.brief = p.brief.slice(0, 2000); if (p.t === 'bay' && typeof p.hands === 'string' && p.hands.trim()) o.hands = p.hands.slice(0, 160); if (typeof p.label === 'string' && p.label.trim()) o.label = p.label.slice(0, 48); if (p.t === 'intake' && typeof p.projectRoot === 'string' && p.projectRoot.trim()) o.projectRoot = p.projectRoot.trim().slice(0, 4096); if (p.t === 'intake' && p.limits && typeof p.limits === 'object') { const nl = normalizeLimits(p.limits); if (nl) o.limits = { maxHops: nl.maxHops, maxUsdPerMessage: nl.maxUsdPerMessage, maxUsdPerDay: nl.maxUsdPerDay }; } applyJunctionCfg(o, p); if (cleanDoor(p.door)) o.door = p.door; if (typeof p.connectorId === 'string' && p.connectorId.trim()) o.connectorId = p.connectorId.trim(); if (p.t === 'plugin_terminal' && typeof p.pluginId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.pluginId.trim())) o.pluginId = p.pluginId.trim(); return o; });
    // Explicit, pack-owned shrinking only. Keep the rendered centre and floor line;
    // never enlarge obstacles or reinterpret a custom saved size. Idempotent on reload.
    for (const p of doc.props) {
      const m = propRules && propRules(p.t)?.footprintMigration;
        if (!m || !m.from || !m.to || (p.r|0) !== 0 || p.w !== m.from.w || p.h !== m.from.h) continue;
      if (![m.to.w,m.to.h,m.dx,m.dy].every(Number.isInteger) || m.to.w<1 || m.to.h<1 ||
          m.dx<0 || m.dy<0 || m.dx+m.to.w>p.w || m.dy+m.to.h>p.h) continue;
      p.x+=m.dx;p.y+=m.dy;p.w=m.to.w;p.h=m.to.h;
    }
    // belts are additive (v1 docs predate them); keep only well-formed "int,int" -> E|W|N|S entries.
    if (!doc.belts || typeof doc.belts !== 'object' || Array.isArray(doc.belts)) doc.belts = {};
    else { const clean = {}; for (const k in doc.belts) { const d = doc.belts[k]; if (/^-?\d+,-?\d+$/.test(k) && (d === 'E' || d === 'W' || d === 'N' || d === 'S')) clean[k] = d; } doc.belts = clean; }
    if (!Array.isArray(doc.edges)) doc.edges = [];
    doc.edges = doc.edges.map(cleanPipelineEdge).filter(Boolean);
    if (!doc.meta || typeof doc.meta !== 'object') doc.meta = { name: 'STARNET STATION', createdAt: 0, tier: 0, spawnRoomId: null };
    /* ONE-TIME, NON-DESTRUCTIVE BACKFILL of the station id (see freshDoc's note). A doc saved before
       station identity existed carries createdAt 0/absent; give it one now so its per-station latches
       stop colliding with every other station's. It must be SAVED on the same load that stamps it —
       app.js persists immediately when the incoming doc had none — or the stamp would re-roll every
       reload and the latches it keys would be lost instead of merely shared. Never overwrites a
       stamp that is already there. */
    if (!doc.meta.createdAt) doc.meta.createdAt = stationId();
    if (typeof doc._nid !== 'number') doc._nid = doc.order.length + 1;
    for (const p of doc.props) if (!p.id) p.id = 'p' + (doc._nid++);   // backfill ids for legacy/partial props
    // spawnRoomId must point at a live non-corridor room (or null) so removeRoom's guard stays meaningful
    if (!doc.meta.spawnRoomId || !doc.rooms[doc.meta.spawnRoomId])
      doc.meta.spawnRoomId = doc.order.find(id => doc.rooms[id] && doc.rooms[id].kind !== 'corridor') || null;
    // trunkRoomId (the integration-hub room that never seals) — additive; default to the spawn room.
    if (!doc.meta.trunkRoomId || !doc.rooms[doc.meta.trunkRoomId])
      doc.meta.trunkRoomId = doc.meta.spawnRoomId || doc.order.find(id => doc.rooms[id] && doc.rooms[id].kind !== 'corridor') || null;
    return doc;
  }

  return {
    TILE, MARGIN, MIN_ROOM, MIN_HALL, FLOOR_STYLES, FLOOR_MATERIALS, MAT_ORDER, WALL_MATERIALS, WALL_ORDER, HULL_MATERIALS, HULL_ORDER, ROOM_KINDS, KIND_ORDER,
    create: doc => makeStation(doc),
    deserialize: doc => makeStation(clone(doc)),
    defaultDoc: freshDoc,
    // Product entry composition. Keep the empty construction document available to
    // importers and layout tools; existing saves never pass through this factory.
    starterDoc() {
      const doc = freshDoc();
      const room = doc.rooms[doc.meta.spawnRoomId];
      room.rects = [{ x1: 0, y1: 0, x2: 17, y2: 10 }];
      room.name = 'HOME';
      room.floorMat = 'resin';
      room.wallMat = 'panelled';
      room.hullStyle = 'bone';
      doc.props = [
        // The five essentials are real floor grants. Keep the desk unassigned so
        // ensureWorkstation adopts it for the new Commander on the normal boot path.
        // User-approved placement from the live station, 2026-09-15.
        // Preserve this composition and the original 18 x 11 room footprint.
        { id: 'p' + doc._nid++, t: 'desk', x: 8, y: 1, w: 2, h: 1, block: true },
        { id: 'p' + doc._nid++, t: 'war_intelcab', x: 1, y: 0, w: 1, h: 2, block: true },
        { id: 'p' + doc._nid++, t: 'gigs_servercart', x: 1, y: 9, w: 1, h: 1, block: true },
        { id: 'p' + doc._nid++, t: 'comms_dish', x: 14, y: 0, w: 2, h: 2, block: true },
        { id: 'p' + doc._nid++, t: 'workbench', x: 3, y: 1, w: 2, h: 1, block: true },
        { id: 'p' + doc._nid++, t: 'studio', x: 14, y: 8, w: 2, h: 2, block: true },
        { id: 'p' + doc._nid++, t: 'plant', x: 0, y: 0, w: 1, h: 1, block: false },
        { id: 'p' + doc._nid++, t: 'plant', x: 17, y: 0, w: 1, h: 1, block: false }
      ];
      return doc;
    },
    // pure helpers reused by the build layer
    normRect, rectW, rectH, rectsHit, inRect,
    // install the prop-type -> {mount, surface} lookup once for every station this module makes
    setPropRules,
    // capability legibility — prop -> plain power word (WEB/FILES/…); one owned source for the palette tile + Field Manual
    CAP_PROP_MAP, CAP_LABEL, capForProp: t => CAP_PROP_MAP[t] || null, grantLabelForProp,
    // starter-line blueprints — the static catalog the REFIT LINES palette + headless tests read
    BLUEPRINTS,
    // bay-role catalog (guided workflows): placard copy + summon-class wiring for role-carrying docks
    BAY_ROLES, bayRoleInfo: r => BAY_ROLES[r] || null,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WorldModel;
