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

/* 3b. a crowd (Andrew 10-27: "what if a user has like 20 agents"): desks for the job only, more rows when many work, a lounge
   of a few with a plate counting the rest */
{
  const { geom, LOUNGE_MAX } = require('../bin/lib/floor.js');
  const g1 = geom(1380, 460, 20, 1, true), g2 = geom(1380, 460, 20, 2, true);
  A.ok(g2.S < g1.S && g2.per > g1.per, 'a second row makes the room smaller and each row longer: ' + JSON.stringify([g1.S, g1.per, g2.S, g2.per]));
  const SKINS = fs.readdirSync(path.join(__dirname, '..', 'frontend', 'assets', 'sprites')).filter(s => /^approved_/.test(s) && fs.existsSync(path.join(__dirname, '..', 'frontend', 'assets', 'sprites', s, 'type_north_1.png'))).slice(0, 20);
  const cf = makeFloor(feed);
  for (const p of cf.needs(SKINS)) { const f2 = path.join(__dirname, '..', 'frontend', p); feed.add(p, fs.existsSync(f2) ? fs.readFileSync(f2) : null); }
  const crew = SKINS.map((s, i) => ({ id: 'c' + i, name: 'C' + i, set: s, key: 'idle', now: 'web.fetch vercel.com/pricing' }));
  const cbox = { cellW: 10, cellH: 20, cols: 138, rows: 23 };
  let t = 0, cfr = null;
  const run = (ms) => { for (const end = t + ms; t < end; t += 250) cfr = cf.frame({ lead: 'c0', agents: crew }, t, false, cbox); };
  run(3000);
  let L = cf.layout();
  A.eq([L.crowd, L.desks.size, L.more], [true, 1, 19 - LOUNGE_MAX], 'nobody on a job: only the lead\'s desk is anyone\'s, ' + LOUNGE_MAX + ' in the lounge, the rest counted');
  A.ok(cfr.plates.some(p => p.id === '' && p.segs[0][0] === '+' + (19 - LOUNGE_MAX) + ' standing by'), 'the lounge\'s plate: how many more stand by');
  A.eq(cf._sims.size, 1 + LOUNGE_MAX, 'who is out of view is not drawn');
  for (let i = 1; i <= 9; i++) crew[i].key = 'working';
  run(3000);
  L = cf.layout();
  A.ok(L.desks.size === 10 && L.empty.length > 0 && L.front.every(id => /^c[1-9]$/.test(id)), 'nine on the job: a desk each (and the lead\'s), more standing empty: ' + L.desks.size + '/' + L.empty.length);
  const ys = new Set(L.front.map(id => L.desks.get(id)[1]));
  A.ok(ys.size >= 2, 'more than one row seats them: ' + [...ys]);
  A.ok(L.front.every(id => cf._sims.get(id).sat), 'each reached its desk and sits (a long way is walked quickly)');
  const fronts = cfr.plates.filter(p => p.id && L.desks.has(p.id) && p.id !== 'c0');
  const box2 = p => { const w = p.segs.reduce((n, q) => n + q[0].length, 0) + 2; const x = p.col - Math.floor(w / 2); return [x, x + w]; };
  A.ok(!fronts.some(p => fronts.some(q => q !== p && q.row === p.row && box2(q)[0] < box2(p)[1] - 1 && box2(p)[0] < box2(q)[1] - 1)), 'no desk plate covers another (each cut to its desk\'s width)');
  A.eq(L.more, 10 - LOUNGE_MAX, 'the rest: ' + LOUNGE_MAX + ' in view, the others counted');
  const c5 = L.desks.get('c5').join();
  crew[2].key = 'done';
  run(1000);
  A.ok(cf.layout().desks.has('c2') && cf.layout().desks.get('c5').join() === c5, 'one finishes: it keeps its desk a moment, and nobody else\'s desk moves');
  run(4000);
  A.ok(!cf.layout().desks.has('c2'), '...then its desk is free and it goes to the lounge');
  for (let i = 1; i <= 9; i++) crew[i].key = 'idle';
  run(1500);
  A.ok(new Set([...cf.layout().empty, ...cf.layout().desks.values()].map(d => d[1])).size >= 2, 'the job ends: the rows stay a few seconds (no room that breathes)');
  run(6000);
  A.eq(cf.layout().desks.size + cf.layout().empty.length, 1 + geom(1380, 460, 20, 1, true).per, '...then it is one row again');
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
