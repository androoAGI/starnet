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
     done        it stands by its desk a moment (its light green), then goes about the room
     stopped     it sits at its desk in the dark
     idle        it goes about the room: the coffee, the couch, the wall screens, the whiteboard, the rack
   THE HANDOFFS: a run the station says a lead run sent (its run.start names a parentRunId: team.dispatch) flies a task from
   the lead to that worker; when that run ends its result flies back. Each is a line in the floor's LOG too. Nothing is drawn
   that the station did not report.

   makeFloor(feed) → { needs(sets), observe(runs, nameOf, now), frame(scene, now, still, box), log(), lead(runs, focus) }
     scene: { lead, agents: [{ id, name, set, key, now }] }; box: { cellW, cellH, cols, rows }
     frame → { key, sixel, plates: [{ col, row, segs, id }] } | null (null until every skin it needs is in) */
'use strict';

const { LOOK, asciiSixel, POSES, accentRim } = require('./camfeed.js');

const REF_H = 350, WALL = 74;
const DESK_SEAT = [72, 128];   // the camera's own: the chair (and the agent's feet) from the desk's top-left
const DESK_W = 96, ROW_Y = 180, LEAD_Y = 36;
const SPEED = 80;   // world px a second
const FLY_MS = 1400;
const FURN = ['desk', 'chair', 'screens', 'whiteboard', 'rack', 'console', 'plant', 'coffee', 'couch'];
const spritePath = (set, name) => '/assets/sprites/' + set + '/' + name + '.png';
const furnPath = n => '/assets/furniture/' + n + '.png';
const STATE_RGB = { needs: [255, 180, 58], done: [93, 255, 168], stopped: [70, 52, 56] };
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
  const spots = [
    { at: [134, Hw - 24], pose: 'sitS', over: 'couch' }, { at: [216, Hw - 112], pose: 'standN' }, { at: [170, 150], pose: 'standN' },
    { at: [90, Hw - 100], pose: 'stand' }
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
const ON_JOB = { working: 1, needs: 1, stopped: 1 };
const MARK = { working: ['●', 'ph b'], needs: ['▲', 'am b'], done: ['✓', 'ok b'], stopped: ['■', 'dim'] };
const LOUNGE_MAX = 3;   // a crowd's lounge: this many of those with nothing to do (the latest off a job); the rest stand by their desks
const S_MIN = 0.55;     // the room zooms out no further than this (the art stays readable); a crew wider than that, the view pans
const MAX_ROWS = 4;

function makeFloor(feed) {
  const sims = new Map();      // agent id -> its walk
  const flights = [];          // { from, to, kind: 'task'|'result', t0 }
  const events = [];           // the floor's LOG: { at, text, style }
  const known = new Map();     // delegated run id -> { agentId, lead }
  const frames = new Map();
  let lastLayout = null;
  const lastBusy = new Map();  // agent id -> when it was last on the job (the lounge shows the latest first)
  let camX = null, camAt = 0, lastSig = null;  // the view's left edge in the world (a crew too wide to fit pans), and when it last moved

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
  function observe(runs, nameOf, reasonOf, now) {
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
      const why = reasonOf(k.agentId) || 'done';
      flights.push({ from: k.agentId, to: k.lead, kind: why === 'done' ? 'result' : 'failed', t0: now });
      events.push({ at: now, text: nameOf(k.agentId) + ' → ' + nameOf(k.lead) + '  ' + (why === 'done' ? 'done' : why), style: why === 'done' ? 'ok' : 'bad' });
    }
    while (events.length > 50) events.shift();
    for (let i = flights.length - 1; i >= 0; i--) if (now - flights[i].t0 > FLY_MS) flights.splice(i, 1);
  }
  // the lead: the agent whose run has delegated runs under way; else the one in COMMS
  function leadOf(runs, focus) {
    for (const k of known.values()) return k.lead;
    return focus;
  }

  // one agent's walk toward where its state puts it
  function step(a, L, now, spot, relaid) {
    const desk = L.desks.get(a.id);
    const seat = desk ? [desk[0] + DESK_SEAT[0], desk[1] + DESK_SEAT[1]] : null;
    let s = sims.get(a.id);
    if (!s) {
      const r = rnd(a.id), at = seat ? [seat[0] - 40, seat[1] + 8] : L.spots[Math.floor(r() * L.spots.length)].at;
      s = { x: at[0], y: at[1], tx: at[0], ty: at[1], last: now, rand: r, key: a.key, since: now, dir: 1, spot: null, dwellUntil: now + 1500 + r() * 3000, arrived: true };
      sims.set(a.id, s);
    }
    if (s.key !== a.key) { s.key = a.key; s.since = now; if (a.key === 'done') s.spot = null; }
    const dt = Math.min(0.25, Math.max(0, (now - s.last) / 1000));
    s.last = now;
    const atDesk = seat && (a.key === 'working' || a.key === 'needs' || a.key === 'stopped');
    if (atDesk && s.sat) { s.x = seat[0]; s.y = seat[1]; }   // the room re-laid (the picture changed size, a row came or went): it stays in its chair
    if (atDesk) { s.tx = seat[0]; s.ty = seat[1]; s.spot = null; s.arrived = false; }
    else if (s.sat) { s.sat = false; s.tx = s.x - 40; s.ty = s.y + 8; s.spot = null; s.dwellUntil = now + (a.key === 'done' ? 2600 : 600); s.arrived = false; }   // it stands up first
    else if (spot === 'desk') { s.tx = seat[0] - 40; s.ty = seat[1] + 8; s.spot = null; }   // a crowd's lead, between jobs: by its desk (its plate is there)
    else if (spot != null) {   // a crowd's lounger: its own spot (where that is now: the room may have been re-laid)
      if (s.spot !== spot) s.arrived = false;
      s.spot = spot; s.tx = L.spots[spot].at[0]; s.ty = L.spots[spot].at[1];
    }
    else if (s.arrived && now > s.dwellUntil) {
      let n = Math.floor(s.rand() * L.spots.length);
      if (n === s.spot) n = (n + 1) % L.spots.length;
      s.spot = n; s.tx = L.spots[n].at[0] + (s.rand() - 0.5) * 30; s.ty = L.spots[n].at[1]; s.arrived = false;
    }
    if (relaid && !s.walking) { s.x = s.tx; s.y = s.ty; }   // the room re-laid (the picture changed size, the crew grew): who stood still is where it stood, not walking there
    const dx = s.tx - s.x, dy = s.ty - s.y, dist = Math.hypot(dx, dy);
    // a long way (a big room): it hurries, there in a second and a half
    if (s.vx !== s.tx || s.vy !== s.ty) { s.vx = s.tx; s.vy = s.ty; s.v = Math.max(SPEED, dist / 1.5); }
    if (dist > 0.5) { const m = Math.min(dist, s.v * dt); s.x += dx / dist * m; s.y += dy / dist * m; if (Math.abs(dx) > 0.5) s.dir = dx > 0 ? 1 : -1; }
    s.walking = dist > 1;
    if (!s.walking && !s.arrived && !atDesk) { s.arrived = true; s.dwellUntil = now + 3000 + s.rand() * 5000; }
    s.sat = !!atDesk && dist <= 1;
    s.at = !s.walking && !atDesk && s.spot != null ? L.spots[s.spot] : null;
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
    const loungeAt = new Map();   // a crowd: each lounger's own spot (they take turns)
    const spotOf = id => loungeAt.has(id) ? loungeAt.get(id) : null;
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
      // nothing to do: the latest off a job go about the lounge, the rest stand by their desks
      for (const a of others) if (ON_JOB[a.key]) lastBusy.set(a.id, now);
      const off = others.filter(a => !ON_JOB[a.key]).sort((x, y) => (lastBusy.get(y.id) || 0) - (lastBusy.get(x.id) || 0));
      const turn = Math.floor(now / 12000);
      off.slice(0, LOUNGE_MAX).forEach((a, i) => loungeAt.set(a.id, (i + turn) % L.spots.length));
    }
    const S = G.S;
    L.worldW = worldW;
    L.lounge = new Set(loungeAt.keys());
    const sig = [Math.round(worldW), S.toFixed(4), L.rows || 1, ids.length].join(), relaid = lastSig !== null && sig !== lastSig;
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
      const s = step(a, L, still ? 0 : now, !L.crowd ? null : loungeAt.has(a.id) ? spotOf(a.id) : 'desk', relaid);
      let p;
      if (s.sat) p = a.key === 'working' && !still ? pose(a.set, 'type', Math.floor(t / 160) + i) : pose(a.set, 'type', 0);
      else if (s.walking && !still) p = pose(a.set, s.dir > 0 ? 'walkE' : 'walkW', Math.floor(t / 100) + i);
      else if (s.at) p = pose(a.set, s.at.pose, 0) || pose(a.set, 'stand', 0);
      else p = pose(a.set, 'stand', 0);
      return { a, s, p, i };
    }).filter(x => x.p);
    const fl = flights.map(f => ({ f, k: still ? 1 : (now - f.t0) / FLY_MS })).filter(x => x.k >= 0 && x.k <= 1);
    const pulse = still || Math.floor(t / 450) % 2 === 0;
    const rk = [W, H, scene.lead, pulse ? 1 : 0, accentRim().join(), (L.rows || 1) + 'r' + Math.round(camX)].concat(placed.map(x => x.a.id + ':' + x.a.key + ':' + x.p + ':' + Math.round(x.s.x) + ',' + Math.round(x.s.y)), fl.map(x => x.f.to + x.f.kind + Math.round(x.k * 30))).join('|');
    const plates = platesFor(scene, placed, L, S, box);
    if (frames.has(rk)) return Object.assign({}, frames.get(rk), { plates });

    // ---- compose the room ----
    const buf = new Uint8Array(W * H * 3), kind = new Uint8Array(W * H), owner = new Int16Array(W * H).fill(-1);
    const fill = (x0, y0, x1, y1, c) => { for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { const i = (y * W + x) * 3; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; } };
    fill(0, 0, W, H, [12, 12, 12]);
    const wy = Math.round(WALL * S);
    fill(0, 0, W, wy, [24, 17, 19]);
    fill(0, wy, W, wy + Math.max(2, Math.round(2 * S)), LOOK.trim.map(v => Math.min(255, v * 1.2)));   // the wall's trim: the accent
    for (let y = wy + Math.round(14 * S); y < H; y += Math.max(6, Math.round(17 * S))) fill(0, y, W, y + 1, [22, 16, 17]);
    const gap = Math.max(12, Math.round(56 * S));
    for (let x = ((Math.round(30 * S) - ox) % gap + gap) % gap; x < W; x += gap) fill(x, wy + 3, x + 1, H, [17, 13, 14]);
    const blit = (img, left, top, k, who) => {
      for (let y = 0; y < img.h; y++) {
        const yy = top + y; if (yy < 0 || yy >= H) continue;
        for (let x = 0; x < img.w; x++) {
          const xx = left + x; if (xx < 0 || xx >= W) continue;
          const si = (y * img.w + x) * 4; if (img.px[si + 3] < 128) continue;
          const di = yy * W + xx; buf[di * 3] = img.px[si]; buf[di * 3 + 1] = img.px[si + 1]; buf[di * 3 + 2] = img.px[si + 2];
          kind[di] = k; owner[di] = who == null ? -1 : who;
        }
      }
    };
    const layers = [];
    const deskImg = feed.scaledOf(furnPath('desk'), S), chairImg = feed.scaledOf(furnPath('chair'), S);
    for (const d of [...L.desks.values(), ...L.empty]) {
      layers.push({ y: d[1] + deskImg.h / S - 8, draw: () => blit(deskImg, Math.round(d[0] * S) - ox, Math.round(d[1] * S), 3) });
      const sx = d[0] + DESK_SEAT[0], sy = d[1] + DESK_SEAT[1];
      layers.push({ y: sy - 1, draw: () => blit(chairImg, Math.round(sx * S - chairImg.w / 2) - ox, Math.round(sy * S - chairImg.h + 8 * S), 3) });
    }
    for (const [n, x, y, lit] of L.props) { const im = feed.scaledOf(furnPath(n), S); layers.push({ y: y + im.h / S, draw: () => blit(im, Math.round(x * S) - ox, Math.round(y * S), lit ? 2 : 3) }); }
    placed.forEach((x, pi) => {
      const ag = feed.scaledOf(x.p, S);
      const onCouch = x.s.at && x.s.at.over === 'couch';
      layers.push({ y: onCouch ? 1e6 : x.s.y, draw: () => blit(ag, Math.round(x.s.x * S - ag.w / 2) - ox, Math.round(x.s.y * S - ag.h + 23 * S), 1, pi) });
    });
    layers.sort((a, b) => a.y - b.y).forEach(l => l.draw());

    // ---- light: each desk's monitor, in its agent's state; the handoffs in flight, a glowing task or result on an arc ----
    const glowAt = new Float32Array(W * H * 3);
    const glow = (wx, wy2, r, c, amp, floorToo) => {
      const X = wx * S - ox, Y = wy2 * S, R = r * S;
      for (let y = Math.max(0, Math.floor(Y - R)); y < Math.min(H, Math.ceil(Y + R)); y++) for (let x = Math.max(0, Math.floor(X - R)); x < Math.min(W, Math.ceil(X + R)); x++) {
        const d = Math.hypot(x - X, (y - Y) * 1.4) / R; if (d >= 1) continue;
        const i = y * W + x; if (!floorToo && !kind[i]) continue;
        const f = (1 - d) * (1 - d) * amp; glowAt[i * 3] += c[0] * f; glowAt[i * 3 + 1] += c[1] * f; glowAt[i * 3 + 2] += c[2] * f;
      }
    };
    const rim = accentRim();
    const lightOf = key => key === 'working' ? rim.map(v => v * 0.43) : key === 'needs' ? (pulse ? [110, 74, 12] : [48, 30, 6]) : key === 'done' ? [16, 80, 40] : null;
    const stateOf = new Map(placed.map(x => [x.a.id, x.a]));
    for (const [id, d] of L.desks) { const a = stateOf.get(id); const c = a && lightOf(a.key); if (c) glow(d[0] + 82, d[1] + 22, 150, c, 1.2, true); }   // its light pools on the floor too
    const seatOf = id => { const sm = sims.get(id); return sm ? [sm.x, sm.y - 50] : null; };
    for (const { f, k } of fl) {
      const a = seatOf(f.from), b = seatOf(f.to); if (!a || !b) continue;
      const c = f.kind === 'task' ? [255, 180, 58] : f.kind === 'result' ? [93, 255, 168] : [255, 107, 61];
      const at = q => [lerp(a[0], b[0], q), lerp(a[1], b[1], q) - Math.sin(q * Math.PI) * 60];
      for (let q = 0; q < k; q += 0.04) { const [x, y] = at(q); glow(x, y, 9, c, 0.5 * (q / Math.max(k, 0.01)), true); }
      const [x, y] = at(k); glow(x, y, 30, c, 0.9, true); glow(x, y, 8, [255, 255, 255], 1.2, true);
    }

    // ---- the grade: the art's own colours in a dark room, light where light falls (the look Andrew picked 10-26), and a rim
    // in its state's colour round each agent that is not idle ----
    const RIMS = placed.map(x => x.a.key === 'working' ? rim : STATE_RGB[x.a.key] || null).map(c => c && c.map(v => v * 0.75));
    const DARK = [1, 0.8, 0.85, 0.55];   // by kind: the room, an agent, a light source, a surface
    const col = new Float32Array(W * H * 3), light = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const k = kind[i], x = i % W;
      let c = null;
      if (k !== 1) for (const j of [i - 1, i + 1, i - W, i + W]) if (j >= 0 && j < W * H && kind[j] === 1 && (j !== i - 1 || x > 0) && (j !== i + 1 || x < W - 1) && RIMS[owner[j]]) { c = RIMS[owner[j]]; break; }
      let r, g, b;
      if (c) { r = c[0]; g = c[1]; b = c[2]; }
      else {
        const d = DARK[k], gl = k ? 1.4 : 0.5;
        r = buf[i * 3] * d + glowAt[i * 3] * gl; g = buf[i * 3 + 1] * d + glowAt[i * 3 + 1] * gl; b = buf[i * 3 + 2] * d + glowAt[i * 3 + 2] * gl;
        if (k === 1 && owner[i] >= 0 && placed[owner[i]].a.key === 'stopped') { r *= 0.45; g *= 0.45; b *= 0.45; }   // stopped: it sits in the dark
      }
      r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
      col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
      light[i] = Math.max(r, g, b) / 255;
    }
    const res = { key: rk, sixel: asciiSixel(col, light, W, H, [0.015, 0.04], 0.1) };
    if (frames.size > 24) frames.clear();
    frames.set(rk, res);
    return Object.assign({}, res, { plates });
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
      if (a.id === scene.lead && desk) {
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
    return [['standing by', 'dim']];
  }
  return { needs, observe, frame, leadOf, log: () => events.slice(), layout: () => lastLayout, _sims: sims, _known: known };
}

module.exports = { makeFloor, layout, geom, roomHeight, REF_H, LOUNGE_MAX, S_MIN };
