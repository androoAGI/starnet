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
A.eq(fl.log().slice(2).map(e => [e.text, e.style]), [['SCOUT → ULTRON  done', 'ok'], ['FORGE → ULTRON  cancelled', 'bad']], 'a run that ends sends its result back (one that stopped says why)');
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
let f = null;
for (let t = 0; t <= 12000; t += 100) f = pf.frame({ lead: 'agent', agents: agents('working') }, t, false, box);
A.ok(!!f && /^\x1bP/.test(f.sixel) && f.sixel.length > 2000, 'a frame is a Sixel picture of the room');
const scoutDesk = pf.layout().desks.get('scout'), sim = pf._sims.get('scout');
A.ok(sim.sat && Math.round(sim.x) === scoutDesk[0] + 72 && Math.round(sim.y) === scoutDesk[1] + 128, 'a working agent walks to its desk and sits there');
const said = f.plates.map(p => [p.id, p.segs.map(s => s[0]).join('')]);
A.ok(said.some(([id, t]) => id === 'agent' && /^ULTRON {2}lead$/.test(t)) && said.some(([id, t]) => id === 'agent' && t === '● waiting on 1'), 'the lead\'s plate: its name, lead, and how many it waits on: ' + JSON.stringify(said));
A.ok(said.some(([id, t]) => id === 'scout' && t === '● web.fetch vercel.com/pricing'), 'a worker\'s plate: what it is doing now');
A.ok(said.some(([id, t]) => id === 'forge' && t === '✓ done') && said.some(([id, t]) => id === 'echo' && t === 'standing by'), 'done and standing by say so');
A.ok(f.plates.every(p => p.row >= 0 && p.row < box.rows), 'every plate is inside the picture');
const same = pf.frame({ lead: 'agent', agents: agents('working') }, 12000, true, box);
A.ok(same.sixel === pf.frame({ lead: 'agent', agents: agents('working') }, 12000, true, box).sixel, 'a still frame is the same frame');

/* 3b. a crowd (Andrew 10-27: "the more agents the user has, the more it zooms out to fit more desks … almost like it can
   pan, … not all need to always be visible"): a desk each, the room zoomed out a row at a time, past the last zoom a room
   wider than the view that pans to the work; the edges say who is past them */
{
  const { geom, LOUNGE_MAX, S_MIN } = require('../bin/lib/floor.js');
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
  const lounging = [...f20._sims.entries()].filter(([, s]) => s.spot != null).length;
  A.ok(lounging <= LOUNGE_MAX, 'with nothing to do, a few go about the lounge (' + lounging + '), the rest stand by their desks');
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
