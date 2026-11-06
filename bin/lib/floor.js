/* bin/lib/floor.js — the FLOOR page: the whole crew in one room, drawn the way the CREW camera draws its agent (the app's own
   skins and furniture, StarNet's palette, made of ASCII — camfeed.js asciiSixel), wide enough for everyone.

   Who sits where: the LEAD (the agent whose run sent work out, else the agent shown in COMMS) at the desk against the back
   wall, the rest of the crew at a row of desks in front of it, in roster order (a desk stays its agent's).
   A CROWD (more than one row seats — Andrew 10-27: "the more agents … the more it zooms out to fit more desks … almost like
   it can pan"): a desk each still, the room zoomed out a row at a time (up to 4, no smaller than S_MIN) till everyone fits;
   a crew wider than that and the room runs on past the view, which glides to where the work is (else to the lead), and
   each edge says how many are past it. With nothing to do, a few go about a lounge at the left; the rest stand by their desks.

   What each one does follows its real state, as on the camera:
     working     it walks to its desk, sits and types; its monitor's light falls on it, a rim in the accent picks it out
     needs you   it sits at its desk, still; the light turns amber and pulses
     done        it stands by its desk a moment (its light green), then goes about its day as idle does
     stopped     it sits at its desk in the dark (someone stopped its run)
     asked       its run ended asking you a question: it sits at its desk, the light amber, as a live ask does
     unfinished  its run did not finish (cut short, a limit, an empty reply, a refusal): it sits at its desk in the warn light
     failed      its run failed: it sits at its desk in the failure red
     idle        its own day: a while sat at its desk (the monitor dark, no rim), then off about the room — the coffee, the
                 couch, the wall screens, the whiteboard, the rack — a few seconds there, then back or somewhere else; two
                 never take the same place (Andrew 11-02: nobody just stands in front of a desk)
   THE HANDOFFS: a run the station says a lead run sent (its run.start names a parentRunId: team.dispatch) flies a task from
   the lead to that worker; when that run ends its result flies back. Each is a line in the floor's LOG too. Nothing is drawn
   that the station did not report.

   THE DRAWING is kept, not redone: the floor remembers the picture the terminal shows and, each frame, works out which of
   its parts changed (an agent's frame or place, a desk's light, a handoff in flight) and draws again only the patches of
   cells they cover (a whole room took ~380 ms a frame; Andrew 11-02: "insanely laggy"). The picture comes whole the first
   time, when the room itself changes (its size, the zoom, the view panning, the lead) and after repaint().

   makeFloor(feed) → { needs(sets), observe(runs, nameOf, endOf, now), frame(scene, now, still, box), cells(rects), repaint(), log(), lead(runs, focus) }
     scene: { lead, agents: [{ id, name, set, key, text, now }] }; box: { cellW, cellH, cols, rows }
     frame → { key, full, sixel, patches: [{ col, row, sixel }], plates: [{ col, row, segs, id }] } | null (null until every
     skin it needs is in). full: sixel is the whole picture; else patches (none when nothing changed) go at their cells.
     cells([{ col, row, cols, rows }]) → the patches that put the shown picture back over those cells (where a plate stood) */
'use strict';

const RunOutcome = require('../../frontend/app/runoutcome.js');
const { endLook } = require('./station-model.js');
// review r8: how an ended worker flies back, and its LOG line's style, per posture (station-model endLook)
const FLIGHT_OF = { done: 'result', stopped: 'stopped', asked: 'asked', unfinished: 'unfinished', failed: 'failed' };
const LOG_STYLE = { done: 'ok', stopped: 'fg', asked: 'am', unfinished: 'am', failed: 'bad' };

const { LOOK, asciiIdx, POSES, PALETTE, accentRim } = require('./camfeed.js');
const { encodeSixel } = require('./sixel.js');
const GLYPH = require('./ascii-glyphs.js');

const REF_H = 350, WALL = 74;
const DESK_SEAT = [72, 128];   // the camera's own: the chair (and the agent's feet) from the desk's top-left
const DESK_W = 96, ROW_Y = 180, LEAD_Y = 36;
const SPEED = 80;   // world px a second
const FLY_MS = 1400;
const FURN = ['desk', 'chair', 'screens', 'whiteboard', 'rack', 'console', 'plant', 'coffee', 'couch'];
const spritePath = (set, name) => '/assets/sprites/' + set + '/' + name + '.png';
const furnPath = n => '/assets/furniture/' + n + '.png';
// review r8: each ended outcome keeps its own light (station-model endLook keys) — a failure is never drawn as a run someone stopped
const STATE_RGB = { needs: [255, 180, 58], done: [93, 255, 168], stopped: [70, 52, 56], asked: [255, 180, 58], unfinished: [217, 169, 91], failed: [255, 107, 61] };
const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
function rnd(seed) { let s = 9; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* the room for a world WW px wide: desks (the lead's at the back, a row in front), furniture, the places an idle agent goes.
   A CROWD (more agents than one row seats; o.crowd, from makeFloor): a desk each still, in rows of o.per (o.colW apart,
   o.pitch between rows), in roster order; the lounge at the left (the couch, the coffee, the wall screens) */
const LOUNGE_W = 270;
function layout(ids, lead, WW, o) {
  const desks = new Map();
  desks.set(lead, [Math.round(WW / 2 - DESK_W / 2), LEAD_Y]);
  if (!o || !o.crowd) {
    const others = ids.filter(id => id !== lead);
    const room = Math.max(1, Math.floor((WW - 60) / 190));   // desks that fit in the front row, 190 px apart at least
    const front = others.slice(0, room);
    front.forEach((id, i) => desks.set(id, [Math.round(30 + (i + 0.5) * (WW - 60) / front.length - DESK_W / 2), ROW_Y]));
    const props = [['console', 10, 52, 1], ['screens', 70, 18, 1], ['whiteboard', WW - 330, 12], ['rack', WW - 110, 40, 1],
      ['plant', WW / 2 - 160, 66], ['plant', WW / 2 + 112, 66], ['coffee', WW - 56, 262], ['couch', 14, 290]];
    const spots = [
      { at: [WW - 40, 300], pose: 'standN' }, { at: [134, 330], pose: 'sitS', over: 'couch' }, { at: [170, 150], pose: 'standN' },
      { at: [WW - 230, 140], pose: 'standN' }, { at: [WW - 70, 150], pose: 'standN' }, { at: [WW / 2 - 200, 150], pose: 'stand' }
    ];
    return { desks, props, spots, front, empty: [], crowd: false, colW: front.length ? (WW - 60) / front.length : WW };
  }
  const Hw = o.Hw, colW = o.colW;
  ids.filter(id => id !== lead).forEach((id, n) => desks.set(id, [Math.round(LOUNGE_W + (n % o.per + 0.5) * colW - DESK_W / 2), Math.round(ROW_Y + Math.floor(n / o.per) * o.pitch)]));
  const props = [['console', 10, 52, 1], ['screens', 70, 18, 1], ['whiteboard', WW - 330, 12], ['rack', WW - 110, 40, 1],
    ['plant', WW / 2 - 160, 66], ['plant', WW / 2 + 112, 66], ['coffee', 200, Hw - 150], ['couch', 14, Hw - 64], ['plant', 20, Hw - 150]];
  // the lounge's, then the back wall's (the whiteboard, the rack, by the lead's left plant — to its right the lead's plate
  // would cover whoever stood there): an idle crew has places to go
  const spots = [
    { at: [134, Hw - 24], pose: 'sitS', over: 'couch' }, { at: [216, Hw - 112], pose: 'standN' }, { at: [170, 150], pose: 'standN' },
    { at: [90, Hw - 100], pose: 'stand' }, { at: [WW - 230, 140], pose: 'standN' }, { at: [WW - 70, 150], pose: 'standN' },
    { at: [WW / 2 - 200, 150], pose: 'stand' }
  ];
  return { desks, props, spots, front: [...desks.keys()].filter(id => id !== lead), empty: [], crowd: true, colW };
}

/* the room's geometry in a picture W x H px with cells cellH tall and `rows` rows of desks: how tall the world is (Hw), its
   scale (S), how wide (WW), the rows' pitch and how many desks a row seats. Each row's seats (ROW_Y + 128) end ~2.6 text rows
   above the next row's desks (or the floor's foot), so their name plates fit under them at any height */
function geom(W, H, cellH, rows, crowd) {
  const c = 2.6 * cellH / H, band = DESK_SEAT[1] + 14;
  const Hw = Math.max(REF_H, (ROW_Y + band * rows) / Math.max(0.3, 1 - (rows - 1) * c - (rows > 1 ? 3.2 : 2.6) * cellH / H));
  const S = H / Hw, WW = W / S;
  const per = Math.max(1, Math.floor((WW - 60 - (crowd ? LOUNGE_W : 0)) / 190));
  return { Hw, S, WW, per, pitch: band + c * Hw };
}
function roomHeight(H, cellH) { return geom(1, H, cellH, 1, false).Hw; }
const ON_JOB = { working: 1, needs: 1, stopped: 1, asked: 1, unfinished: 1, failed: 1 };
const MARK = { working: ['●', 'ph b'], needs: ['▲', 'am b'], done: ['✓', 'ok b'], stopped: ['■', 'dim'], asked: ['▲', 'am b'], unfinished: ['■', 'am'], failed: ['✗', 'bad'] };
const S_MIN = 0.55;     // the room zooms out no further than this (the art stays readable); a crew wider than that, the view pans
const MAX_ROWS = 4;
// an idle agent's day: how long it stays sat at its desk, and at a place it went to (ms, from..to)
const REST_MS = [5000, 14000], DWELL_MS = [3000, 8000], COUCH_MS = [6000, 11000];
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const lcm = (a, b) => a / gcd(a, b) * b;

function makeFloor(feed) {
  const sims = new Map();      // agent id -> its walk
  const flights = [];          // { from, to, kind: 'task'|'result', t0 }
  const events = [];           // the floor's LOG: { at, text, style }
  const known = new Map();     // delegated run id -> { agentId, lead }
  const taken = new Map();     // idle place (index into the layout's spots) -> the agent there or on its way
  let lastLayout = null;
  let camX = null, camAt = 0, lastSig = null;  // the view's left edge in the world (a crew too wide to fit pans), and when it last moved
  // what the terminal shows: { sig (the room itself), els (each part's look and where), idx (a palette index a pixel), W, H }
  let shown = null;

  // what the room still lacks to draw these skins: the furniture and each set's pose frames (every fallback)
  function needs(sets) {
    const want = FURN.map(furnPath);
    for (const set of sets) if (set) for (const list of Object.values(POSES)) for (const alts of list) for (const n of alts) want.push(spritePath(set, n));
    return [...new Set(want)].filter(p => !feed.hasAsset(p));
  }
  function pose(set, kind, i) {
    const alts = POSES[kind][i % POSES[kind].length];
    for (const n of alts) { const p = spritePath(set, n); if (feed.asset(p)) return p; }
    return null;
  }

  /* THE HANDOFFS, from the station's runs (model.state.runs): a delegated run seen for the first time flies a task to its
     agent; a delegated run gone (its run ended) flies its result back to the lead */
  /* review r8: endOf(runId, agentId) is the ENDED RUN'S OWN end (station-model endOf: { reason, outcome, failureCode }), never its agent's latest —
     two runs of one worker ending before a paint each fly back as themselves; an older caller's reason word still resolves (RunOutcome.ofWord) */
  function observe(runs, nameOf, endOf, now) {
    for (const r of runs.values()) {
      if (!r.parentRunId || known.has(r.runId)) continue;
      const parent = runs.get(r.parentRunId);
      const lead = (parent && parent.agentId) || r.delegatedBy || '';
      if (!lead || lead === r.agentId) continue;
      known.set(r.runId, { agentId: r.agentId, lead });
      flights.push({ from: lead, to: r.agentId, kind: 'task', t0: now });
      events.push({ at: now, text: nameOf(lead) + ' → ' + nameOf(r.agentId) + '  team.dispatch' + (r.prompt ? '  "' + String(r.prompt).replace(/\s+/g, ' ') + '"' : ''), style: 'fg' });
    }
    for (const [runId, k] of known) {
      if (runs.has(runId)) continue;
      known.delete(runId);
      // none known is "ended", never done. Each outcome flies back as itself (review r8): a result, a stop (review r7), a question, a run that did
      // not finish (amber) or a failure (red) — every non-success read 'failed' in red before
      const end = endOf(runId, k.agentId);
      const look = end ? endLook(typeof end === 'string' ? RunOutcome.ofWord(end) : (RunOutcome.isOutcome(end.outcome) ? end : RunOutcome.ofWord(end.reason))) : null;
      flights.push({ from: k.agentId, to: k.lead, kind: !look ? 'result' : FLIGHT_OF[look.key], t0: now });
      events.push({ at: now, text: nameOf(k.agentId) + ' → ' + nameOf(k.lead) + '  ' + (!look ? 'ended' : look.key === 'done' ? 'done' : look.word), style: !look ? 'fg' : LOG_STYLE[look.key] });
    }
    while (events.length > 50) events.shift();
    for (let i = flights.length - 1; i >= 0; i--) if (now - flights[i].t0 > FLY_MS) flights.splice(i, 1);
  }
  // the lead: the agent whose run has delegated runs under way; else the one in COMMS
  function leadOf(runs, focus) {
    for (const k of known.values()) return k.lead;
    return focus;
  }

  /* an agent's day off the job: s.mode is 'job' (at its desk for its run), 'up' (just up from it, a moment by the desk),
     'rest' (sat at its desk, nothing to do) or 'go' (off to, or at, a place in the room: s.spot, held in `taken`) */
  const span = (r, [lo, hi]) => lo + r() * (hi - lo);
  function release(s, id) { if (s.spot != null && taken.get(s.spot) === id) taken.delete(s.spot); s.spot = null; }
  const spotAt = (L, s) => [L.spots[s.spot].at[0] + (s.jx || 0), L.spots[s.spot].at[1]];
  // its next thing: a free place in the room (not the one it was at), else its desk; preferRest: its desk, if it has one
  function nextIdle(a, L, s, seat, now, preferRest) {
    const was = s.spot;
    release(s, a.id);
    let n = -1;
    if (!(preferRest && seat)) {
      const k = L.spots.length, from = Math.floor(s.rand() * k);
      for (let j = 0; j < k && n < 0; j++) { const i = (from + j) % k; if (i !== was && !taken.has(i)) n = i; }
    }
    if (n >= 0) { s.mode = 'go'; s.spot = n; taken.set(n, a.id); s.jx = (s.rand() - 0.5) * 24; }
    else if (seat) { s.mode = 'rest'; s.until = now + span(s.rand, REST_MS); }
    else { s.mode = 'go'; s.spot = Math.floor(s.rand() * L.spots.length); s.jx = (s.rand() - 0.5) * 50; }   // no desk, every place taken: it shares one
    s.arrived = false;
  }

  // one agent's walk toward where its state (and, off the job, its day) puts it
  function step(a, L, now, relaid) {
    const desk = L.desks.get(a.id);
    const seat = desk ? [desk[0] + DESK_SEAT[0], desk[1] + DESK_SEAT[1]] : null;
    let s = sims.get(a.id);
    if (!s) {
      // first seen: at its desk (on the job, or most of the time anyway) or already at a place in the room — never walking in
      const r = rnd(a.id);
      s = { x: 0, y: 0, last: now, rand: r, key: a.key, since: now, dir: 1, spot: null, mode: '', arrived: false, until: 0 };
      sims.set(a.id, s);
      if (seat && (ON_JOB[a.key] || r() < 0.6)) { s.mode = ON_JOB[a.key] ? 'job' : 'rest'; s.until = now + span(r, REST_MS) * r(); s.x = seat[0]; s.y = seat[1]; }
      else { nextIdle(a, L, s, seat, now, false); [s.x, s.y] = s.mode === 'go' ? spotAt(L, s) : seat; }   // every place taken: its desk
    }
    if (s.key !== a.key) { s.key = a.key; s.since = now; }
    const dt = Math.min(0.25, Math.max(0, (now - s.last) / 1000));
    s.last = now;
    if (seat && ON_JOB[a.key]) { if (s.mode !== 'job') { release(s, a.id); s.mode = 'job'; s.arrived = false; } }
    else if (s.mode === 'job' && s.sat) { s.mode = 'up'; s.tx = s.x - 40; s.ty = s.y + 8; s.until = now + (a.key === 'done' ? 2600 : 600); s.arrived = false; }   // it stands up first
    else if (s.mode === 'job' || !s.mode) nextIdle(a, L, s, seat, now, false);
    else if (s.mode === 'up' && s.arrived && now > s.until) nextIdle(a, L, s, seat, now, false);
    else if (s.mode === 'rest' && (!seat || (s.sat && now > s.until))) nextIdle(a, L, s, seat, now, false);
    else if (s.mode === 'go' && (s.spot == null || s.spot >= L.spots.length)) nextIdle(a, L, s, seat, now, false);
    else if (s.mode === 'go' && s.arrived && now > s.until) nextIdle(a, L, s, seat, now, s.rand() < 0.55);
    // where that is in the room as it is laid out now (a re-lay moves desks and places)
    const seated = s.mode === 'job' || s.mode === 'rest';
    if (seated) { if (s.sat) { s.x = seat[0]; s.y = seat[1]; } s.tx = seat[0]; s.ty = seat[1]; }   // sat, it stays in its chair
    else if (s.mode === 'go') [s.tx, s.ty] = spotAt(L, s);
    if (relaid && !s.walking) { s.x = s.tx; s.y = s.ty; }   // the room re-laid (the picture changed size, the crew grew): who stood still is where it stood, not walking there
    const dx = s.tx - s.x, dy = s.ty - s.y, dist = Math.hypot(dx, dy);
    // a long way (a big room): it hurries, there in a second and a half
    if (s.vx !== s.tx || s.vy !== s.ty) { s.vx = s.tx; s.vy = s.ty; s.v = Math.max(SPEED, dist / 1.5); }
    if (dist > 0.5) { const m = Math.min(dist, s.v * dt); s.x += dx / dist * m; s.y += dy / dist * m; if (Math.abs(dx) > 0.5) s.dir = dx > 0 ? 1 : -1; }
    s.walking = dist > 1;
    if (!s.walking && !s.arrived) { s.arrived = true; if (s.mode === 'go') s.until = now + span(s.rand, L.spots[s.spot].over === 'couch' ? COUCH_MS : DWELL_MS); }
    s.sat = seated && dist <= 1;
    s.at = !s.walking && s.mode === 'go' ? L.spots[s.spot] : null;
    return s;
  }

  /* frame(scene, now, still, box) → { key, sixel, plates } | null */
  function frame(scene, now, still, box) {
    const sets = scene.agents.map(a => a.set).filter(Boolean);
    if (needs(sets).length) return null;
    const W = box.cols * box.cellW, H = box.rows * box.cellH;
    if (W < 60 || H < 60) return null;
    // the room is as tall as it must be for each row's plates to fit under it: two text rows below the seated feet
    const ids = scene.agents.map(a => a.id), others = scene.agents.filter(a => a.id !== scene.lead);
    let G = geom(W, H, box.cellH, 1, false), L, worldW = G.WW;
    if (others.length <= G.per) L = layout(ids, scene.lead, G.WW);
    else {
      // a crowd: a desk each, the room zoomed out a row at a time till everyone's seats fit (no further than S_MIN); a crew
      // wider than that keeps the last zoom and the room runs on past the view's edges (it pans, below)
      let pick = null;
      for (let nr = 1; nr <= MAX_ROWS; nr++) {
        const g = geom(W, H, box.cellH, nr, true);
        if (pick && g.S < S_MIN) break;
        pick = { g, nr };
        if (g.per * nr >= others.length) break;
      }
      G = pick.g;
      const per = Math.ceil(others.length / pick.nr), fits = G.per * pick.nr >= others.length;
      const colW = fits ? (G.WW - 30 - LOUNGE_W) / per : 190;
      worldW = fits ? G.WW : LOUNGE_W + 30 + per * colW;
      L = layout(ids, scene.lead, worldW, { crowd: true, Hw: G.Hw, per, pitch: G.pitch, colW });
      L.rows = pick.nr;
    }
    const S = G.S;
    L.worldW = worldW;
    const sig = [Math.round(worldW), S.toFixed(4), L.rows || 1, ids.length].join(), relaid = lastSig !== null && sig !== lastSig;
    // the room's places changed (a crowd's lounge ↔ one row's): who was off to one picks again
    if (lastLayout && (lastLayout.crowd !== L.crowd || lastLayout.spots.length !== L.spots.length)) { taken.clear(); for (const s of sims.values()) if (s.mode === 'go') { s.mode = ''; s.spot = null; } }
    lastSig = sig;
    lastLayout = L;
    // ---- the view: a room wider than the picture pans to where the work is (who is working or waits on you, and the
    // handoffs in flight), else to the lead; it glides there ----
    const viewW = W / S, maxCam = Math.max(0, worldW - viewW);
    const deskMid = id => { const d = L.desks.get(id); return d ? d[0] + DESK_W / 2 : null; };
    const busyX = scene.agents.filter(a => ON_JOB[a.key] && a.key !== 'stopped').map(a => deskMid(a.id)).concat(flights.map(f => deskMid(f.to))).filter(x => x != null);
    const focusX = busyX.length ? (Math.min(...busyX) + Math.max(...busyX)) / 2 : deskMid(scene.lead) || worldW / 2;
    const camTo = Math.max(0, Math.min(maxCam, focusX - viewW / 2));
    if (camX == null || still || !maxCam) camX = camTo;
    else camX += (camTo - camX) * Math.min(1, Math.max(0, now - camAt) / 1000 * 2.5);
    camX = Math.max(0, Math.min(maxCam, camX));
    camAt = now;
    L.camX = camX;
    const ox = Math.round(camX * S);
    const t = still ? 0 : now;
    // ---- where everyone is, and how it holds itself ----
    const placed = scene.agents.filter(a => a.set).map((a, i) => {
      const s = step(a, L, still ? 0 : now, relaid);
      let p;
      if (s.sat) p = a.key === 'working' && !still ? pose(a.set, 'type', Math.floor(t / 160) + i) : ON_JOB[a.key] ? pose(a.set, 'type', 0) : pose(a.set, 'sitN', 0);
      else if (s.walking && !still) p = pose(a.set, s.dir > 0 ? 'walkE' : 'walkW', Math.floor(t / 100) + i);
      else if (s.at) p = pose(a.set, s.at.pose, 0) || pose(a.set, 'stand', 0);
      else p = pose(a.set, 'stand', 0);
      return { a, s, p, i };
    }).filter(x => x.p);
    L.lounge = new Set(placed.filter(x => x.s.mode === 'go').map(x => x.a.id));
    const fl = flights.map(f => ({ f, k: still ? 1 : (now - f.t0) / FLY_MS })).filter(x => x.k >= 0 && x.k <= 1);
    const pulse = still || Math.floor(t / 450) % 2 === 0;
    const plates = platesFor(scene, placed, L, S, box);

    // ---- what the picture is made of, part by part: each agent (its frame, where, its state's rim), each desk's light, each
    // handoff in flight. The room itself the same (roomSig), only the cells under the parts that changed are drawn again ----
    const rim = accentRim();
    const lightOf = key => key === 'working' ? rim.map(v => v * 0.43) : key === 'needs' || key === 'asked' ? (pulse ? [110, 74, 12] : [48, 30, 6]) : key === 'done' ? [16, 80, 40] : key === 'unfinished' ? [70, 52, 20] : key === 'failed' ? [80, 24, 12] : null;
    const stateOf = new Map(placed.map(x => [x.a.id, x.a]));
    const roomSig = [W, H, sig, ox, scene.lead, rim.join(), LOOK.trim.join(), [...L.desks].map(([id, d]) => id + ':' + d.join()).join()].join('|');
    const els = new Map();
    const sprites = placed.map(x => {
      const ag = feed.scaledOf(x.p, S);
      const left = Math.round(x.s.x * S - ag.w / 2) - ox, top = Math.round(x.s.y * S - ag.h + 23 * S);
      const onCouch = !!(x.s.at && x.s.at.over === 'couch');
      els.set('a:' + x.a.id, { sig: [x.p, left, top, x.a.key, onCouch].join(), r: [left - 1, top - 1, left + ag.w + 1, top + ag.h + 1] });   // its rim is a pixel round it
      return { x, ag, left, top, onCouch };
    });
    const lights = [];
    for (const [id, d] of L.desks) {
      const a = stateOf.get(id), c = a && lightOf(a.key);
      if (!c) continue;
      const X = (d[0] + 82) * S - ox, Y = (d[1] + 22) * S, R = 150 * S;
      lights.push([d[0] + 82, d[1] + 22, c]);
      els.set('l:' + id, { sig: c.join(), r: [Math.floor(X - R) - 1, Math.floor(Y - R) - 1, Math.ceil(X + R) + 1, Math.ceil(Y + R) + 1] });
    }
    const seatOf = id => { const sm = sims.get(id); return sm ? [sm.x, sm.y - 50] : null; };
    const arcs = [];
    for (const { f, k } of fl) {
      const a = seatOf(f.from), b = seatOf(f.to); if (!a || !b) continue;
      const c = f.kind === 'task' ? [255, 180, 58] : f.kind === 'result' ? [93, 255, 168] : f.kind === 'stopped' ? [140, 150, 160] : f.kind === 'asked' ? [255, 211, 74] : f.kind === 'unfinished' ? [217, 169, 91] : [255, 107, 61];
      const at = q => [lerp(a[0], b[0], q), lerp(a[1], b[1], q) - Math.sin(q * Math.PI) * 60];
      // the trail it leaves: a dot every 1/25 of the way, each as bright as how far along the flight it is (dim by the sender) —
      // so every dot brightens as the flight goes on (the same sum as before the picture was kept: byte for byte), and a flying
      // arc's dots are drawn again each frame; only that, the head and what else changed, never the whole room
      const trail = []; for (let q = 0; q < k; q += 0.04) trail.push([...at(q), 0.5 * (q / Math.max(k, 0.01))]);
      const head = at(k);
      arcs.push({ trail, head, c, k });
      const id = 'f:' + f.from + '>' + f.to + '@' + f.t0, dot = (x, y, r) => [Math.floor(x * S - ox - r), Math.floor(y * S - r), Math.ceil(x * S - ox + r), Math.ceil(y * S + r)];
      trail.forEach(([x, y, amp], n) => els.set(id + '#' + n, { sig: Math.round(x) + ',' + Math.round(y) + ',' + amp, r: dot(x, y, 9 * S + 2) }));
      els.set(id + '#head', { sig: Math.round(head[0] * S) + ',' + Math.round(head[1] * S), r: dot(head[0], head[1], 30 * S + 2) });
    }

    // ---- which cells to draw: all of them the first time (or when the room itself changed), else those under what changed ----
    const TA = lcm(GLYPH.cw, box.cellW), TB = lcm(GLYPH.ch, box.cellH);   // a patch starts on a text cell and on a glyph cell
    let full = still || !shown || shown.sig !== roomSig || shown.cellW !== box.cellW || shown.cellH !== box.cellH, regions = [];
    if (!full) {
      const damage = [];
      for (const [k, e] of els) { const o = shown.els.get(k); if (!o || o.sig !== e.sig) { damage.push(e.r); if (o) damage.push(o.r); } }
      for (const [k, o] of shown.els) if (!els.has(k)) damage.push(o.r);
      regions = tilesOf(damage, W, H, TA, TB);
      if (regions.reduce((n, r) => n + (r[2] - r[0]) * (r[3] - r[1]), 0) > 0.55 * W * H) full = true;   // most of it: the whole is no dearer
    }
    if (full) { regions = [[0, 0, W, H]]; shown = { sig: roomSig, idx: new Int16Array(W * H), W, H, cellW: box.cellW, cellH: box.cellH }; }
    shown.els = els;

    // ---- compose one region of the room (with a pixel round it, for the rims), lit and graded, as ASCII: palette indexes ----
    const deskImg = feed.scaledOf(furnPath('desk'), S), chairImg = feed.scaledOf(furnPath('chair'), S);
    const RIMS = placed.map(x => x.a.key === 'working' ? rim : STATE_RGB[x.a.key] || null).map(c => c && c.map(v => v * 0.75));
    const DARK = [1, 0.8, 0.85, 0.55];   // by kind: the room, an agent, a light source, a surface
    function compose(rx0, ry0, rx1, ry1) {
      const px0 = Math.max(0, rx0 - 1), py0 = Math.max(0, ry0 - 1), px1 = Math.min(W, rx1 + 1), py1 = Math.min(H, ry1 + 1);
      const pw = px1 - px0, N = pw * (py1 - py0);
      const buf = new Uint8Array(N * 3), kind = new Uint8Array(N), owner = new Int16Array(N).fill(-1);
      const fill = (x0, y0, x1, y1, c) => { for (let y = Math.max(py0, y0); y < Math.min(py1, y1); y++) for (let x = Math.max(px0, x0); x < Math.min(px1, x1); x++) { const i = ((y - py0) * pw + x - px0) * 3; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; } };
      fill(0, 0, W, H, [12, 12, 12]);
      const wy = Math.round(WALL * S);
      fill(0, 0, W, wy, [24, 17, 19]);
      fill(0, wy, W, wy + Math.max(2, Math.round(2 * S)), LOOK.trim.map(v => Math.min(255, v * 1.2)));   // the wall's trim: the accent
      for (let y = wy + Math.round(14 * S); y < H; y += Math.max(6, Math.round(17 * S))) fill(0, y, W, y + 1, [22, 16, 17]);
      const gap = Math.max(12, Math.round(56 * S));
      for (let x = ((Math.round(30 * S) - ox) % gap + gap) % gap; x < W; x += gap) fill(x, wy + 3, x + 1, H, [17, 13, 14]);
      const blit = (img, left, top, k, who) => {
        const y0 = Math.max(0, py0 - top), y1 = Math.min(img.h, py1 - top), x0 = Math.max(0, px0 - left), x1 = Math.min(img.w, px1 - left);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const si = (y * img.w + x) * 4; if (img.px[si + 3] < 128) continue;
          const di = (top + y - py0) * pw + left + x - px0; buf[di * 3] = img.px[si]; buf[di * 3 + 1] = img.px[si + 1]; buf[di * 3 + 2] = img.px[si + 2];
          kind[di] = k; owner[di] = who == null ? -1 : who;
        }
      };
      const layers = [];
      for (const d of [...L.desks.values(), ...L.empty]) {
        layers.push({ y: d[1] + deskImg.h / S - 8, draw: () => blit(deskImg, Math.round(d[0] * S) - ox, Math.round(d[1] * S), 3) });
        const sx = d[0] + DESK_SEAT[0], sy = d[1] + DESK_SEAT[1];
        layers.push({ y: sy - 1, draw: () => blit(chairImg, Math.round(sx * S - chairImg.w / 2) - ox, Math.round(sy * S - chairImg.h + 8 * S), 3) });
      }
      for (const [n, x, y, lit] of L.props) { const im = feed.scaledOf(furnPath(n), S); layers.push({ y: y + im.h / S, draw: () => blit(im, Math.round(x * S) - ox, Math.round(y * S), lit ? 2 : 3) }); }
      sprites.forEach((sp, pi) => layers.push({ y: sp.onCouch ? 1e6 : sp.x.s.y, draw: () => blit(sp.ag, sp.left, sp.top, 1, pi) }));
      layers.sort((a, b) => a.y - b.y).forEach(l => l.draw());

      // light: each desk's monitor, in its agent's state (it pools on the floor too); the handoffs, a glowing task or result on an arc
      const glowAt = new Float32Array(N * 3);
      const glow = (wx, wy2, r, c, amp) => {
        const X = wx * S - ox, Y = wy2 * S, R = r * S;
        for (let y = Math.max(py0, Math.floor(Y - R)); y < Math.min(py1, Math.ceil(Y + R)); y++) for (let x = Math.max(px0, Math.floor(X - R)); x < Math.min(px1, Math.ceil(X + R)); x++) {
          const d = Math.hypot(x - X, (y - Y) * 1.4) / R; if (d >= 1) continue;
          const i = (y - py0) * pw + x - px0, f = (1 - d) * (1 - d) * amp;
          glowAt[i * 3] += c[0] * f; glowAt[i * 3 + 1] += c[1] * f; glowAt[i * 3 + 2] += c[2] * f;
        }
      };
      for (const [x, y, c] of lights) glow(x, y, 150, c, 1.2);
      for (const { trail, head, c, k } of arcs) {
        for (const [x, y, amp] of trail) glow(x, y, 9, c, amp);
        glow(head[0], head[1], 30, c, 0.9); glow(head[0], head[1], 8, [255, 255, 255], 1.2);
      }

      // the grade: the art's own colours in a dark room, light where light falls (the look Andrew picked 10-26), and a rim in
      // its state's colour round each agent that is not idle
      const rw = rx1 - rx0, rh = ry1 - ry0;
      const col = new Float32Array(rw * rh * 3), light = new Float32Array(rw * rh);
      for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
        const i = (y - py0) * pw + x - px0, o = (y - ry0) * rw + x - rx0, k = kind[i];
        let c = null;
        if (k !== 1) for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - pw : -1, y < H - 1 ? i + pw : -1]) if (j >= 0 && kind[j] === 1 && RIMS[owner[j]]) { c = RIMS[owner[j]]; break; }
        let r, g, b;
        if (c) { r = c[0]; g = c[1]; b = c[2]; }
        else {
          const d = DARK[k], gl = k ? 1.4 : 0.5;
          r = buf[i * 3] * d + glowAt[i * 3] * gl; g = buf[i * 3 + 1] * d + glowAt[i * 3 + 1] * gl; b = buf[i * 3 + 2] * d + glowAt[i * 3 + 2] * gl;
          if (k === 1 && owner[i] >= 0 && placed[owner[i]].a.key === 'stopped') { r *= 0.45; g *= 0.45; b *= 0.45; }   // stopped: it sits in the dark
        }
        r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
        col[o * 3] = r; col[o * 3 + 1] = g; col[o * 3 + 2] = b;
        light[o] = Math.max(r, g, b) / 255;
      }
      const part = asciiIdx(col, light, rw, rh, [0.015, 0.04], 0.1, { x: rx0, y: ry0, W, H });
      for (let y = 0; y < rh; y++) shown.idx.set(part.subarray(y * rw, (y + 1) * rw), (ry0 + y) * W + rx0);
    }
    for (const r of regions) compose(...r);
    const key = roomSig + '#' + [...els].map(([k, e]) => k + '=' + e.sig).join('|');   // all the picture shows
    if (full) return { key, full: true, sixel: encodeSixel(shown.idx, W, H, PALETTE), patches: [], plates };
    return { key, full: false, sixel: '', patches: regions.map(patchOf), plates };
  }

  // the shown picture's cells x0..x1, y0..y1 (px, on text cells) as a Sixel to put at its cell
  function patchOf([x0, y0, x1, y1]) {
    const w = x1 - x0, h = y1 - y0, part = new Int16Array(w * h);
    for (let y = 0; y < h; y++) part.set(shown.idx.subarray((y0 + y) * shown.W + x0, (y0 + y) * shown.W + x1), y * w);
    return { col: x0 / shown.cellW, row: y0 / shown.cellH, sixel: encodeSixel(part, w, h, PALETTE) };
  }
  // the shown picture back over these text cells (where a plate stood and stands no more)
  function cells(rects) {
    if (!shown) return [];
    const out = [];
    for (const r of rects) {
      const x0 = Math.max(0, r.col * shown.cellW), y0 = Math.max(0, r.row * shown.cellH);
      const x1 = Math.min(shown.W, (r.col + r.cols) * shown.cellW), y1 = Math.min(shown.H, (r.row + r.rows) * shown.cellH);
      if (x1 > x0 && y1 > y0) out.push(patchOf([x0, y0, x1, y1]));
    }
    return out;
  }

  /* the name plates, in text cells over the picture: under each desk agent its name and what it is doing (cut to its desk's
     width; where desks stand close, one line: its state's mark and its name); the lead's beside it; an agent with no desk,
     under its feet. A crowd: one standing by says only its name. A view that pans: at each edge, how many are past it (and
     how many of those work, or wait on you) */
  function platesFor(scene, placed, L, S, box) {
    const out = [];
    const ox = (L.camX || 0) * S;
    const cell = (wx, wy2) => [Math.round((wx * S - ox) / box.cellW), Math.round(wy2 * S / box.cellH)];
    const kids = [...known.values()].filter(k => k.lead === scene.lead).length;
    const fit = Math.max(4, Math.floor(L.colW * S / box.cellW) - 1), tight = fit < 12;
    for (const { a, s } of placed) {
      const desk = L.desks.get(a.id);
      const word = cut(stateWord(a), desk ? fit : 24);
      if (a.id === scene.lead && desk && (kids || s.mode !== 'go')) {   // off about the room, its plate goes with it (below)
        const [c, r] = cell(desk[0] + DESK_SEAT[0] + 70, desk[1] + DESK_SEAT[1]);
        out.push({ id: a.id, col: c, row: r - 4, segs: [[a.name, 'ph b'], ['  lead', 'dim']] });
        out.push({ id: a.id, col: c, row: r - 3, segs: kids ? [['● waiting on ' + kids, 'ph b']] : word });
        if (kids && a.now) out.push({ id: a.id, col: c, row: r - 2, segs: cut([[a.now, 'dim']], Math.max(8, box.cols - c - 3)) });
        continue;
      }
      const [c, r] = desk && s.sat ? cell(desk[0] + DESK_SEAT[0], desk[1] + DESK_SEAT[1]) : cell(s.x, s.y);
      // under its feet; near the floor's foot (no room there), over its head
      const at = r + 2 < box.rows ? r + 1 : Math.max(0, r - Math.round(110 * S / box.cellH) - 1);
      const nameSt = a.key === 'idle' ? 'fg b' : 'hi b';
      const solo = L.crowd && (L.lounge.has(a.id) || a.key === 'idle');
      if (solo) { out.push({ id: a.id, col: c, row: at, segs: MARK[a.key] ? [[MARK[a.key][0] + ' ', MARK[a.key][1]], [a.name, nameSt]] : [[a.name, nameSt]], center: true, solo: L.lounge.has(a.id) }); continue; }   // standing by: its name
      if (tight && desk) { out.push({ id: a.id, col: c, row: at, segs: cut(MARK[a.key] ? [[MARK[a.key][0] + ' ', MARK[a.key][1]], [a.name, nameSt]] : [[a.name, nameSt]], fit), center: true }); continue; }
      out.push({ id: a.id, col: c, row: at, segs: cut([[a.name, nameSt]], desk ? fit : 24), center: true });
      out.push({ id: a.id, col: c, row: at + 1, segs: word, center: true });
    }
    if (L.crowd && (L.worldW - L.camX) * S > box.cols * box.cellW + 4 || L.camX > 2) {
      const past = { l: [], r: [] };
      for (const { a } of placed) { const d = L.desks.get(a.id); if (!d || a.id === scene.lead) continue; const x = cell(d[0] + DESK_W / 2, 0)[0]; if (x < 1) past.l.push(a); else if (x > box.cols - 2) past.r.push(a); }
      const tag = (list, arrow, left) => {
        if (!list.length) return null;
        const w = list.filter(a => a.key === 'working').length, n = list.filter(a => a.key === 'needs').length;
        const segs = [[left ? arrow + ' ' + list.length : list.length + ' ' + arrow, 'fg b']].concat(w ? [['  ● ' + w, 'ph b']] : [], n ? [['  ▲ ' + n, 'am b']] : []);
        return left ? segs : segs.slice(1).concat([['  ', 'fg']], segs.slice(0, 1));
      };
      const mid = Math.floor(box.rows / 2), tl = tag(past.l, '◀', true), tr = tag(past.r, '▶', false);
      if (tl) out.push({ id: '', col: 0, row: mid, segs: tl });
      if (tr) out.push({ id: '', col: box.cols, row: mid, segs: tr });
    }
    // loungers stand close: a lounger's plate that would cover another goes up a row (or a few)
    const span = p => { const w = p.segs.reduce((n, q) => n + q[0].length, 0) + 2; const x = p.center ? p.col - Math.floor(w / 2) : p.col; return [x, x + w]; };
    const hits = p => out.some(q => q !== p && q.row === p.row && span(q)[0] < span(p)[1] && span(p)[0] < span(q)[1]);
    for (const p of out) if (p.solo) for (let k = 0; k < 4 && hits(p); k++) p.row--;
    return out.filter(p => p.row >= 0 && p.row < box.rows && (!p.center || (p.col >= 0 && p.col < box.cols)));
  }
  // segs cut to n characters, the last one an ellipsis when it had to cut
  function cut(segs, n) {
    const out = [];
    let left = n;
    for (const [tx, st] of segs) {
      if (left <= 0) break;
      if (tx.length <= left) { out.push([tx, st]); left -= tx.length; continue; }
      out.push([tx.slice(0, Math.max(0, left - 1)).replace(/\s+$/, '') + '…', st]); left = 0;
    }
    return out;
  }
  function stateWord(a) {
    if (a.key === 'working') { const m = /^(\S+)\s*(.*)$/.exec(a.now || 'thinking') || []; return [['● ' + (m[1] || 'thinking'), 'ph b']].concat(m[2] ? [[' ' + m[2], 'fg']] : []); }
    if (a.key === 'needs') return [['▲ needs you', 'am b']];
    if (a.key === 'done') return [['✓ done', 'ok b']];
    if (a.key === 'stopped') return [['■ stopped', 'dim']];
    // review r8: a run that asked, did not finish or failed says so in its own word and tone — never the grey '■ stopped' of a run someone stopped
    if (MARK[a.key] && a.key !== 'working' && a.key !== 'needs' && a.key !== 'done') return [[MARK[a.key][0] + ' ' + (a.text || a.key), MARK[a.key][1]]];
    return [['standing by', 'dim']];
  }
  return { needs, observe, frame, cells, repaint: () => { shown = null; }, leadOf, log: () => events.slice(), layout: () => lastLayout, _sims: sims, _known: known, _stateWord: stateWord, _shown: () => shown };
}

/* the damaged rects (px, any size, may run off the picture) as the fewest whole tiles (TA × TB px: each starts on a text cell
   and a glyph cell) that cover them: [x0, y0, x1, y1] each, runs along a row of tiles merged down the rows that repeat them */
function tilesOf(rects, W, H, TA, TB) {
  const tw = Math.ceil(W / TA), th = Math.ceil(H / TB), on = new Uint8Array(tw * th);
  for (const [x0, y0, x1, y1] of rects) {
    const a0 = Math.max(0, Math.floor(x0 / TA)), a1 = Math.min(tw, Math.ceil(x1 / TA)), b0 = Math.max(0, Math.floor(y0 / TB)), b1 = Math.min(th, Math.ceil(y1 / TB));
    for (let b = b0; b < b1; b++) for (let a = a0; a < a1; a++) on[b * tw + a] = 1;
  }
  const out = [];
  let open = new Map();
  for (let b = 0; b <= th; b++) {
    const next = new Map();
    if (b < th) for (let a = 0; a < tw;) {
      if (!on[b * tw + a]) { a++; continue; }
      const s = a; while (a < tw && on[b * tw + a]) a++;
      const k = s + ',' + a, r = open.get(k);
      if (r) { r[3] = b + 1; open.delete(k); next.set(k, r); } else next.set(k, [s, b, a, b + 1]);
    }
    for (const r of open.values()) out.push(r);
    open = next;
  }
  return out.map(([a0, b0, a1, b1]) => [a0 * TA, b0 * TB, Math.min(W, a1 * TA), Math.min(H, b1 * TB)]);
}

module.exports = { makeFloor, layout, geom, roomHeight, tilesOf, REF_H, S_MIN };
