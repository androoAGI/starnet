'use strict';
/* test/cli-floor.test.js — the terminal's FLOOR (bin/lib/floor.js + its page in tui.js). Locks:
     1. who sits where: the lead at the back desk, the crew at a row in front (a desk stays its agent's), more agents than
        desks go deskless; the lead is the agent whose run sent work out, else the one in COMMS
     2. the handoffs come only from what the station reports: a run that names a parentRunId flies a task from the lead and
        writes the LOG; when it ends its result flies back (a run that stopped says so, in the bad colour); a run nobody sent
        draws nothing
     3. the picture: none until the art is in; then a Sixel of the room, the plates naming each agent and what it is doing
        (the lead's says how many it waits on), and a working agent reaching its desk and sitting there
     4. the page: where the terminal draws images it leaves the picture's region (the whole width, no CREW column) over the
        LOG; where it does not, the same truth as text — the lead, its workers on ├─▶ branches, the rest, the LOG */
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const camfeed = require('../bin/lib/camfeed.js');
const { makeFloor, layout } = require('../bin/lib/floor.js');
const tui = require('../bin/lib/tui.js');
const { makeStation } = require('../bin/lib/station-model.js');

/* 1. layout */
{
  const L = layout(['a', 'b', 'c', 'd'], 'b', 900);
  const lead = L.desks.get('b');
  A.ok(lead[1] < L.desks.get('a')[1] && Math.abs(lead[0] + 48 - 450) <= 1, 'the lead\'s desk is at the back, in the middle');
  A.eq(['a', 'c', 'd'].map(id => L.desks.get(id)[1]), [180, 180, 180], 'the rest sit in a row in front of it');
  A.ok(L.desks.get('a')[0] < L.desks.get('c')[0] && L.desks.get('c')[0] < L.desks.get('d')[0], '...in roster order');
  const narrow = layout(['a', 'b', 'c', 'd', 'e', 'f'], 'a', 500);
  A.eq([narrow.desks.size, narrow.front.length], [3, 2], 'a narrow floor: as many desks as fit (190 px apart), the rest go deskless');
}

/* 2. the handoffs */
const feed = camfeed.makeCamFeed();
const fl = makeFloor(feed);
const NAMES = { agent: 'ULTRON', scout: 'SCOUT', forge: 'FORGE', echo: 'ECHO' };
const nameOf = id => NAMES[id] || id;
let reason = 'done';
const runs = new Map();
runs.set('L', { runId: 'L', agentId: 'agent', prompt: 'ship it' });
fl.observe(runs, nameOf, () => reason, 1000);
A.eq([fl.log().length, fl.leadOf(runs, 'echo')], [0, 'echo'], 'a run nobody sent draws nothing; with nothing sent out the lead is the agent in COMMS');
runs.set('w1', { runId: 'w1', agentId: 'scout', parentRunId: 'L', prompt: 'research  pricing' });
runs.set('w2', { runId: 'w2', agentId: 'forge', parentRunId: 'L', prompt: 'build it' });
fl.observe(runs, nameOf, () => reason, 2000);
A.eq(fl.log().map(e => e.text), ['ULTRON → SCOUT  team.dispatch  "research pricing"', 'ULTRON → FORGE  team.dispatch  "build it"'], 'each delegated run: a LOG line, from the lead, with what it was sent');
A.eq(fl.leadOf(runs, 'echo'), 'agent', 'the lead is the agent whose run sent the work');
fl.observe(runs, nameOf, () => reason, 2500);
A.eq(fl.log().length, 2, 'a run already seen is not sent twice');
runs.delete('w1');
fl.observe(runs, nameOf, () => reason, 3000);
reason = 'cancelled';
runs.delete('w2');
fl.observe(runs, nameOf, () => reason, 3100);
// review r7: a worker someone STOPPED flies back as a stop in the plain style, never as a red failed result
A.eq(fl.log().slice(2).map(e => [e.text, e.style]), [['SCOUT → ULTRON  done', 'ok'], ['FORGE → ULTRON  stopped', 'fg']], 'a run that ends sends its result back (one that stopped says so, never as a failure)');
A.eq(fl.leadOf(runs, 'echo'), 'echo', 'no work out: back to the agent in COMMS');
const viaName = makeFloor(feed);
const r2 = new Map([['x', { runId: 'x', agentId: 'scout', parentRunId: 'gone', delegatedBy: 'agent' }]]);
viaName.observe(r2, nameOf, () => 'done', 1);
A.eq(viaName.log().map(e => e.text), ['ULTRON → SCOUT  team.dispatch'], 'a lead run this terminal never saw: the station\'s delegatedBy names the lead');

/* 3. the picture, from the app's own art */
const SETS = { agent: 'approved_ultron', scout: 'approved_secretagent', forge: 'approved_masterchief', echo: 'approved_capybara' };
const pf = makeFloor(feed);
const box = { cellW: 10, cellH: 20, cols: 100, rows: 18 };
const agents = key => [{ id: 'agent', name: 'ULTRON', set: SETS.agent, key: 'working', now: 'team.dispatch' }, { id: 'scout', name: 'SCOUT', set: SETS.scout, key, now: 'web.fetch vercel.com/pricing' },
  { id: 'forge', name: 'FORGE', set: SETS.forge, key: 'done', now: '' }, { id: 'echo', name: 'ECHO', set: SETS.echo, key: 'idle', now: '' }];
A.eq(pf.frame({ lead: 'agent', agents: agents('working') }, 0, false, box), null, 'no picture until the art is in');
const missing = pf.needs(Object.values(SETS));
A.ok(missing.some(p => /furniture\/desk\.png$/.test(p)) && missing.some(p => /approved_secretagent\/type_north_1\.png$/.test(p)), 'it asks for the furniture and every pose of every skin');
for (const p of missing) { const f = path.join(__dirname, '..', 'frontend', p); feed.add(p, fs.existsSync(f) ? fs.readFileSync(f) : null); }
A.eq(pf.needs(Object.values(SETS)), [], 'then it has all it needs');
const pr = new Map([['L', { runId: 'L', agentId: 'agent' }], ['w', { runId: 'w', agentId: 'scout', parentRunId: 'L', prompt: 'p' }]]);
pf.observe(pr, nameOf, () => 'done', 0);
let f = null, first = null;
for (let t = 0; t <= 12000; t += 100) { f = pf.frame({ lead: 'agent', agents: agents('working') }, t, false, box); first = first || f; }
A.ok(first.full && /^\x1bP/.test(first.sixel) && first.sixel.length > 2000, 'the first frame is a Sixel picture of the whole room');
A.ok(!f.full && f.sixel === '' && f.patches.every(p => /^\x1bP/.test(p.sixel) && p.col % 3 === 0 && p.row % 3 === 0), 'after it, only patches of what changed, each on a text cell and a glyph cell: ' + JSON.stringify(f.patches.map(p => [p.col, p.row])));
const scoutDesk = pf.layout().desks.get('scout'), sim = pf._sims.get('scout');
A.ok(sim.sat && Math.round(sim.x) === scoutDesk[0] + 72 && Math.round(sim.y) === scoutDesk[1] + 128, 'a working agent walks to its desk and sits there');
const said = f.plates.map(p => [p.id, p.segs.map(s => s[0]).join('')]);
A.ok(said.some(([id, t]) => id === 'agent' && /^ULTRON {2}lead$/.test(t)) && said.some(([id, t]) => id === 'agent' && t === '● waiting on 1'), 'the lead\'s plate: its name, lead, and how many it waits on: ' + JSON.stringify(said));
A.ok(said.some(([id, t]) => id === 'scout' && t === '● web.fetch vercel.com/pricing'), 'a worker\'s plate: what it is doing now');
A.ok(said.some(([id, t]) => id === 'forge' && t === '✓ done') && said.some(([id, t]) => id === 'echo' && t === 'standing by'), 'done and standing by say so');
A.ok(f.plates.every(p => p.row >= 0 && p.row < box.rows), 'every plate is inside the picture');
const same = pf.frame({ lead: 'agent', agents: agents('working') }, 12000, true, box);
A.ok(same.full && same.sixel === pf.frame({ lead: 'agent', agents: agents('working') }, 12000, true, box).sixel, 'a still frame is the same whole frame');

/* 3a. THE DRAWING IS KEPT (Andrew 11-02: "insanely laggy" — a whole room a frame was ~380 ms): what the patches put up is,
   pixel for pixel, the picture drawn whole; nothing changed, nothing is sent; a plate gone, the picture comes back there */
{
  const { tilesOf } = require('../bin/lib/floor.js');
  A.eq(tilesOf([[35, 10, 50, 70], [-20, -5, 4, 4], [1000, 900, 1200, 990]], 300, 180, 30, 60), [[0, 0, 60, 60], [30, 60, 60, 120]], 'damage becomes whole tiles inside the picture, a row\'s run carried down the rows that repeat it');
  A.eq(tilesOf([[0, 0, 70, 130]], 300, 180, 30, 60), [[0, 0, 90, 180]], '...one block when they do');
  const kept = makeFloor(feed), twin = makeFloor(feed);
  const crew = agents('working');
  const runs2 = new Map();
  let bad = 0, sent = 0, whole = 0;
  for (let i = 0, t = 50000; i < 160; i++, t += 100) {
    if (i === 20) crew[3].key = 'needs';
    if (i === 50) crew[1].key = 'done';
    if (i === 40) { runs2.set('L', { runId: 'L', agentId: 'agent' }); runs2.set('w', { runId: 'w', agentId: 'echo', parentRunId: 'L' }); }
    if (i === 70) runs2.delete('w');
    for (const fl2 of [kept, twin]) fl2.observe(runs2, nameOf, () => 'done', t);
    const k = kept.frame({ lead: 'agent', agents: crew }, t, false, box);
    twin.repaint(); twin.frame({ lead: 'agent', agents: crew }, t, false, box);
    if (k.full) whole++; else sent += k.patches.length;
    const a = kept._shown().idx, b = twin._shown().idx;
    for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) { bad++; break; }
  }
  // (a few go whole on purpose: an amber light pulsing over most of a small room is no dearer sent whole)
  A.ok(bad === 0 && whole < 12 && sent > 0, 'patched, frame after frame (walks, a pulse, a handoff flying, states changing), the picture is the whole one exactly: ' + JSON.stringify({ bad, whole, sent }));
  // the trail of a flying handoff brightens as the flight goes on (each dot is 0.5 x how far along it is, over how far the flight
  // has gone): the same dot, near where the arc starts and far from either head, is lit more at 95% of the flight than at 50%
  {
    const { geom } = require('../bin/lib/floor.js');
    const at = k => {
      const fx = makeFloor(feed), rs = new Map();
      for (let t = 0; t <= 12000; t += 100) fx.frame({ lead: 'agent', agents: agents('working') }, t, false, box);
      rs.set('L', { runId: 'L', agentId: 'agent' }); rs.set('w', { runId: 'w', agentId: 'scout', parentRunId: 'L' });
      fx.observe(rs, nameOf, () => 'done', 12100);
      fx.frame({ lead: 'agent', agents: agents('working') }, 12100 + 1400 * k, false, box);
      return fx;
    };
    const lo = at(0.5), hi = at(0.95), sh = lo._shown(), S = geom(sh.W, sh.H, box.cellH, 1, false).S;
    const a = lo._sims.get('agent'), b = lo._sims.get('scout');
    const dotAt = q => [a.x + (b.x - a.x) * q, (a.y - 50) + ((b.y - 50) - (a.y - 50)) * q - Math.sin(q * Math.PI) * 60];
    const [dx, dy] = dotAt(0.2), r = Math.round(5 * S), cx = Math.round(dx * S - (sh.ox || 0)), cy = Math.round(dy * S), ih = hi._shown();
    let lit = 0, dim = 0;
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) { const p = lo._shown().idx[y * sh.W + x], q = ih.idx[y * sh.W + x]; if (p !== q) lit++; else dim++; }
    A.ok(lit > 0, 'the trail of a handoff brightens as it flies (the dot by the sender differs between 50% and 95% of the flight): ' + JSON.stringify({ lit, same: dim }));
  }
  const dark = makeFloor(feed), sat = agents('stopped').map(a => Object.assign(a, { key: 'stopped' }));
  dark.frame({ lead: 'agent', agents: sat }, 0, false, box);
  let quiet = null; for (let t = 100; t <= 4000; t += 100) quiet = dark.frame({ lead: 'agent', agents: sat }, t, false, box);
  A.ok(!quiet.full && quiet.patches.length === 0, 'a crew sat in the dark, nothing changing: nothing is sent');
  const [back] = kept.cells([{ col: 10, row: 2, cols: 8, rows: 1 }]);
  const d = require('../bin/lib/sixel.js').decodeSixel(back.sixel), sh = kept._shown();
  let off = 0; for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (d.px[y * d.width + x] !== sh.idx[(40 + y) * sh.W + 100 + x]) off++;
  A.ok(back.col === 10 && back.row === 2 && d.width === 80 && d.height === 20 && off === 0, 'cells(): the shown picture, back over the cells where a plate stood');
}

/* 3c. THE ONE-PASS SORT writes the same bytes as the pass-per-colour encoder it replaced (the FLOOR's speed came from sorting each
   band's pixels by colour once; what the terminal is sent must not change by a byte, in any of the three fills) */
{
  const { encodeSixel } = require('../bin/lib/sixel.js');
  function reference(idx, width, height, palette, opts) {
    const fill = !!(opts && opts.fill);
    let s = '\x1bP0;' + (fill ? 0 : 1) + ';0q"1;1;' + width + ';' + height;
    palette.forEach(([r, g, b], i) => { s += '#' + i + ';2;' + Math.round(r * 100 / 255) + ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255); });
    for (let band = 0; band < height; band += 6) {
      let first = true;
      for (let c = 0; c < palette.length; c++) {
        let line = '', used = false, run = 0, prev = -1;
        const flush = () => { if (run === 0) return; const ch = String.fromCharCode(63 + prev); line += run > 3 ? '!' + run + ch : ch.repeat(run); run = 0; };
        for (let x = 0; x < width; x++) {
          let bits = 0;
          for (let k = 0; k < 6; k++) { const y = band + k; if (y < height && idx[y * width + x] === c) bits |= 1 << k; }
          if (bits) used = true;
          if (bits === prev) run++; else { flush(); prev = bits; run = 1; }
        }
        if (!used) continue;
        if (prev !== 0) flush();
        s += (first ? '' : '$') + '#' + c + line;
        first = false;
      }
      s += '-';
    }
    return s + '\x1b\\';
  }
  let seed = 7; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pal = Array.from({ length: 40 }, (_, i) => [i * 6, 255 - i * 6, i * 3]);
  let off = 0, runs = 0;
  for (const [W, H] of [[97, 61], [30, 6], [5, 13], [200, 18]]) for (let k = 0; k < 8; k++) {
    const idx = new Int16Array(W * H);
    for (let i = 0; i < idx.length; i++) idx[i] = rand() < 0.15 ? -1 : Math.floor(rand() * (k % 2 ? 40 : 6));
    for (const o of [undefined, { fill: true }]) { runs++; if (encodeSixel(idx, W, H, pal, o) !== reference(idx, W, H, pal, o)) off++; }
  }
  A.ok(off === 0 && runs === 64, 'the one-pass encoder is byte for byte the old one (' + off + ' of ' + runs + ' differ)');
}

/* 3b. a crowd (Andrew 10-27: "the more agents the user has, the more it zooms out to fit more desks … almost like it can
   pan, … not all need to always be visible"): a desk each, the room zoomed out a row at a time, past the last zoom a room
   wider than the view that pans to the work; the edges say who is past them */
{
  const { geom, S_MIN } = require('../bin/lib/floor.js');
  const g1 = geom(1380, 540, 20, 1, true), g3 = geom(1380, 540, 20, 3, true);
  A.ok(g3.S < g1.S && g3.per > g1.per, 'more rows: a smaller room, longer rows: ' + JSON.stringify([g1.S, g1.per, g3.S, g3.per]));
  const SKINS = fs.readdirSync(path.join(__dirname, '..', 'frontend', 'assets', 'sprites')).filter(s => /^approved_/.test(s) && fs.existsSync(path.join(__dirname, '..', 'frontend', 'assets', 'sprites', s, 'type_north_1.png')));
  const crewOf = n => Array.from({ length: n }, (_, i) => ({ id: 'c' + i, name: 'C' + i, set: SKINS[i % SKINS.length], key: 'idle', now: 'web.fetch vercel.com/pricing' }));
  const loaded = makeFloor(feed);
  for (const p of loaded.needs(SKINS.slice(0, 40))) { const f2 = path.join(__dirname, '..', 'frontend', p); feed.add(p, fs.existsSync(f2) ? fs.readFileSync(f2) : null); }
  const cbox = { cellW: 10, cellH: 20, cols: 138, rows: 27 };
  const runFor = (cf, crew, from, ms, box) => { let fr = null; for (let t = from; t < from + ms; t += 250) fr = cf.frame({ lead: 'c0', agents: crew }, t, false, box || cbox); return fr; };

  // twenty: everyone at a desk, the room zoomed out to fit them all — no panning
  const c20 = crewOf(20), f20 = makeFloor(feed);
  let fr = runFor(f20, c20, 0, 3000);
  let L = f20.layout();
  const g20 = geom(cbox.cols * cbox.cellW, cbox.rows * cbox.cellH, cbox.cellH, L.rows, true);
  A.ok(L.crowd && L.desks.size === 20 && L.rows >= 2 && g20.S >= S_MIN, 'twenty: a desk each, in ' + L.rows + ' rows, the room zoomed out to ' + g20.S.toFixed(2));
  A.ok(L.camX === 0 && Math.round(L.worldW) === Math.round(g20.WW), '...and all of it in view (no pan)');
  A.eq([...f20._sims.keys()].length, 20, 'everyone is drawn');
  // with nothing to do (Andrew 11-02: agents standing in front of their desks "looks ridiculous"): each one's own day, sat at
  // its desk a while, then off about the room; nobody stands by a desk, two never hold one place
  const day = makeFloor(feed), idle20 = crewOf(20);
  const seen = { sat: new Set(), out: new Set() };
  let standing = 0, shared = 0;
  for (let t = 0; t < 60000; t += 100) {
    day.frame({ lead: 'c0', agents: idle20 }, t, false, cbox);
    const held = new Map();
    for (const [id, s] of day._sims) {
      if (s.sat) seen.sat.add(id); else if (s.mode === 'go') seen.out.add(id);
      if (!s.sat && !s.walking && s.mode !== 'go') standing++;
      if (s.mode === 'go' && s.arrived && day._sims.size <= day.layout().spots.length + 20) { if (held.has(s.spot) && day.layout().desks.has(id)) shared++; held.set(s.spot, id); }
    }
  }
  A.ok(standing === 0, 'idle, nobody stands still by a desk (' + standing + ' agent-frames did)');
  A.ok(seen.sat.size >= 15 && seen.out.size >= 10, 'in a minute most sat at their desk and many went about the room: ' + seen.sat.size + ' sat, ' + seen.out.size + ' out');
  A.eq(shared, 0, 'two with desks never hold the same place');
  A.ok(fr.plates.filter(p => p.id && p.id !== 'c0').every(p => p.segs.length <= 2 && !/standing by/.test(p.segs.map(s => s[0]).join(''))), 'standing by, a crowd\'s plate is just its name');
  for (let i = 1; i <= 9; i++) c20[i].key = 'working';
  fr = runFor(f20, c20, 3000, 3000);
  L = f20.layout();
  A.ok([1, 2, 3, 4, 5, 6, 7, 8, 9].every(i => f20._sims.get('c' + i).sat), 'nine sent work: each walks to its own desk and sits (a long way is walked quickly)');
  const fronts = fr.plates.filter(p => p.id && p.id !== 'c0' && p.center);
  const span = p => { const w = p.segs.reduce((n, q) => n + q[0].length, 0) + 2; const x = p.col - Math.floor(w / 2); return [x, x + w]; };
  A.ok(!fronts.some(p => fronts.some(q => q !== p && q.row === p.row && span(q)[0] < span(p)[1] - 1 && span(p)[0] < span(q)[1] - 1)), 'no plate covers another (each cut to its desk\'s width)');
  const c1 = L.desks.get('c1').join();
  const still = [...f20._sims.entries()].filter(([, s]) => !s.walking && !s.sat).map(([id]) => id);
  runFor(f20, c20, 6000, 500, Object.assign({}, cbox, { rows: 21 }));   // an ask card takes the bottom of the page: the picture is shorter
  A.ok(f20.layout().desks.get('c1').join() !== c1 && still.every(id => !f20._sims.get(id).walking) && [1, 2, 3].every(i => f20._sims.get('c' + i).sat), 'the picture changes size: the room re-lays, and nobody walks over to where they already were');

  // forty: past the last zoom the room runs on past the view, which pans to the work and says who is past each edge
  const c40 = crewOf(40), f40 = makeFloor(feed);
  fr = runFor(f40, c40, 0, 2000);
  L = f40.layout();
  const view = cbox.cols * cbox.cellW / geom(cbox.cols * cbox.cellW, cbox.rows * cbox.cellH, cbox.cellH, L.rows, true).S;
  A.ok(L.desks.size === 40 && L.worldW > view + 100, 'forty: a desk each still, the room wider than the view: ' + Math.round(L.worldW) + ' > ' + Math.round(view));
  const leadX = L.desks.get('c0')[0] + 48;
  A.ok(Math.abs(L.camX + view / 2 - leadX) < 5, 'nothing going on: the view is on the lead');
  const right = Array.from({ length: 6 }, (_, i) => L.desks.get('c' + (39 - i * 2))[0]);
  for (let i = 0; i < 6; i++) c40[39 - i * 2].key = 'working';
  const before = L.camX;
  fr = runFor(f40, c40, 2000, 4000);
  L = f40.layout();
  A.ok(L.camX > before && right.every(x => x >= L.camX - 1 && x + 96 <= L.camX + view + 1), 'work at the far end: the view glides there, the workers all in it');
  const tags = fr.plates.filter(p => p.id === '').map(p => p.segs.map(s => s[0]).join(''));
  const pastLeft = [...L.desks.entries()].filter(([id, d]) => id !== 'c0' && (d[0] + 48 - L.camX) * (cbox.cols * cbox.cellW / view) / cbox.cellW < 1).length;
  A.ok(tags.some(t => t === '◀ ' + pastLeft), 'the left edge says how many are past it: ' + JSON.stringify(tags) + ' / ' + pastLeft);
  c40[1].key = 'needs';
  fr = runFor(f40, c40, 6000, 500);
  const tl = fr.plates.filter(p => p.id === '' && p.col === 0).map(p => p.segs.map(s => s[0]).join(''))[0] || '';
  A.ok(/▲ 1/.test(tl) || f40.layout().camX < L.camX, 'one past the edge waits on you: the edge says so (or the view goes to it): ' + tl);
}

/* 4. the page */
const m = makeStation();
m.setRoster({ agents: [{ agentId: 'agent', name: 'ULTRON' }, { agentId: 'scout', name: 'SCOUT' }, { agentId: 'echo', name: 'ECHO' }] });
m.apply('agent.run.start', { runId: 'L', agentId: 'agent', prompt: 'ship it' }, 1000);
m.apply('agent.run.start', { runId: 'w', agentId: 'scout', parentRunId: 'L', delegatedBy: 'agent', prompt: 'research' }, 1000);
m.apply('agent.tool_call', { runId: 'w', agentId: 'scout', name: 'web.fetch', callId: 'c1', argsSummary: '{"url":"vercel.com/pricing"}' }, 1100);
A.eq([m.state.runs.get('w').parentRunId, m.state.runs.get('w').delegatedBy], ['L', 'agent'], 'the station model keeps the lead run a worker\'s run names');
const log = [{ at: new Date(2026, 9, 26, 20, 14, 8).getTime(), text: 'ULTRON → SCOUT  team.dispatch  "research"', style: 'fg' }];
const base = { focus: 'agent', page: 'floor', input: '', scroll: 0, still: true, logo: 'plain', streams: {}, pageData: {} };
const text = tui.render(m, Object.assign({}, base, { floorView: { images: false, lead: 'agent', kids: ['scout'], log } }), { cols: 110, rows: 34 }, 1200);
const plain = text.map(tui.toPlain);
const at = re => plain.findIndex(l => re.test(l));
A.ok(at(/ULTRON {2}lead {2}● /) >= 0 && at(/└─▶ SCOUT {2}● web\.fetch/) === at(/ULTRON {2}lead/) + 1, 'no images: the lead, its worker on a branch under it, what each is doing: ' + plain.filter(l => /ULTRON|SCOUT/.test(l)).join(' / '));
A.ok(at(/ECHO {2}standing by/) > at(/└─▶ SCOUT/), '...then the rest of the crew');
A.ok(at(/LOG ─/) >= 0 && at(/20:14:08 {2}ULTRON → SCOUT {2}team\.dispatch {2}"research"/) === at(/LOG ─/) + 1, 'the LOG of the handoffs under it');
A.eq(text.floor, null, 'no picture region without images');
A.ok(plain.some(l => /┘ FLOOR └|╭─ FLOOR ─/.test(l)), 'FLOOR is the place you are in (on the tab rule, or the frame title)');
const img = tui.render(m, Object.assign({}, base, { floorView: { images: true, ready: true, lead: 'agent', kids: ['scout'], log } }), { cols: 110, rows: 34 }, 1200);
A.ok(!!img.floor && img.floor.cols >= 100 && img.floor.rows >= 8, 'with images: the picture\'s region, nearly the whole width (no CREW column): ' + JSON.stringify(img.floor));
const ip = img.map(tui.toPlain);
A.ok(ip.findIndex(l => /LOG ─/.test(l)) >= img.floor.y + img.floor.rows, '...the LOG under it');
const big = makeStation();
big.setRoster({ agents: Array.from({ length: 20 }, (_, i) => ({ agentId: 'g' + i, name: 'G' + i })) });
const bigText = tui.render(big, Object.assign({}, base, { focus: 'g0', floorView: { images: false, lead: 'g0', kids: [], log: [] } }), { cols: 110, rows: 26 }, 1200).map(tui.toPlain);
A.ok(bigText.some(l => /\b\d+ standing by {2}G1, G2, G3/.test(l)), 'no images, a crowd that would not fit: who stands by on one line: ' + bigText.filter(l => /standing by/.test(l)).join(' / '));

A.report('cli-floor.test');
