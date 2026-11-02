'use strict';
/* test/station-design.test.js: THE STATION DESIGNER. The composer (rooms in groups), the themes (one palette, a whole station), starting
   from a prebuild, the retheme edit, and the design review the model reads. Taste is judged by eye on real renders; this holds what a
   render cannot be trusted to show every time: no sealed floor, seats that face their tables, real equipment kept, palettes that exist,
   one undo, the same answer twice. */
const A = require('./_assert.js');
const M = require('../frontend/app/worldmodel.js'), P = require('../frontend/app/pipeline.js'), W = require('../frontend/app/workflowline.js');
const SB = require('../frontend/app/stationbuilder.js'), T = require('../frontend/app/stationtemplates.js'), Sprites = require('../frontend/app/propsprites.js');
const RS = require('../frontend/app/roomstyles.js'), SD = require('../frontend/app/stationdesign.js'), LL = require('../frontend/app/linelayout.js'), LE = require('../frontend/app/lineedit.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');

M.setPropRules(t => { const s = Sprites.spec(t); return s ? { mount: s.mount || null, stack: !!s.stack, surface: !!s.surface, flat: !!s.flat } : null; });
const crew = [{ id: 'agent', name: 'NOVA' }, { id: 'rex', name: 'REX' }];
const env = { WorldModel: M, Pipeline: P, WorkflowLine: W, crew, heroId: 'agent', PropSprites: Sprites, RoomStyles: RS, StationTemplates: T, StationDesign: SD, LineLayout: LL, LineEdit: LE, EquipmentHelp: require('../frontend/app/equipmenthelp.js') };
const fresh = () => { const s = M.create(M.starterDoc()); s.ensureWorkstation('agent'); s.ensureWorkstation('rex'); return s; };
const snap = st => JSON.stringify(st.serialize());
const STYLES = Object.keys(SD.RECIPES).filter(k => k !== 'bridge');   // the main room's recipe is no style a room can ask for
const room = (st, name) => st.rooms().find(r => r.name === name);

/* ---- every palette is made of materials that exist, and covers every family ---- */
for (const id of SD.THEME_ORDER) {
  const th = SD.THEMES[id];
  for (const k of ['name', 'about', 'accent']) A.ok(th[k], id + ': has ' + k);
  for (const f of ['living', 'work', 'heavy', 'play', 'green']) {
    A.ok(th[f] && M.FLOOR_STYLES[th[f].deck.style] && M.FLOOR_MATERIALS[th[f].deck.mat], id + ': ' + f + ' has a real floor');
    A.ok(th[f] && M.FLOOR_STYLES[th[f].walls.style] && M.WALL_MATERIALS[th[f].walls.mat], id + ': ' + f + ' has real walls');
  }
  A.ok(M.FLOOR_STYLES[th.accent], id + ': a real accent');
  A.ok(M.FLOOR_STYLES[th.corridor.style] && M.FLOOR_MATERIALS[th.corridor.mat] && M.WALL_MATERIALS[th.corridor.walls.mat], id + ': real corridors');
  A.eq(SD.resolveTheme(id), id, id + ': resolves by id');
}
A.eq(SD.resolveTheme('a moody cyberpunk club'), 'neon', 'a phrase finds its palette');
A.eq(SD.resolveTheme('cozy cabin'), 'timber', 'a word finds its palette');
A.eq(SD.resolveTheme('zzz'), null, 'an unknown word is no palette');
A.eq(SD.resolveTheme(''), null, 'nothing is no palette');
for (const s of STYLES) A.ok(SD.FAMILY[s], s + ': belongs to a family');

/* ---- a whole station in each palette: it plans, builds, applies to the plan exactly, and comes off in one undo ---- */
const ROOMS = [{ name: 'LOUNGE', style: 'lounge' }, { name: 'LAB', style: 'lab' }, { name: 'LIBRARY', style: 'library' }, { name: 'ARCADE', style: 'games' }, { name: 'GARDEN', style: 'garden' }, { name: 'OFFICE', style: 'desks' }];
for (const id of SD.THEME_ORDER) {
  const st = fresh(), before = snap(st);
  const pl = SB.planBuild(st.serialize(), { layout: { pattern: 'diamond', theme: id, rooms: ROOMS }, replace: true }, env);
  A.ok(pl.ok, id + ': plans (' + (pl.error || '') + ')');
  if (!pl.ok) continue;
  A.eq(snap(st), before, id + ': planning changes nothing');
  const again = SB.planBuild(st.serialize(), { layout: { pattern: 'diamond', theme: id, rooms: ROOMS }, replace: true }, env);
  A.eq(again.plan.resultSig, pl.plan.resultSig, id + ': the same request plans the same station');
  const r = SB.apply(st, pl.plan, env);
  A.ok(r.ok, id + ': builds (' + (r.error || '') + ')');
  if (!r.ok) continue;
  const th = SD.THEMES[id];
  for (const q of ROOMS) {
    const rm = room(st, q.name), f = th[SD.FAMILY[q.style]];
    A.ok(rm, id + ': ' + q.name + ' stands');
    if (!rm) continue;
    A.eq(rm.floorStyle, f.deck.style, id + ': ' + q.name + ' has the palette floor');
    A.eq(rm.floorMat, f.deck.mat, id + ': ' + q.name + ' has the palette material');
    A.eq(rm.wallStyle || rm.floorStyle, f.walls.style, id + ': ' + q.name + ' has the palette wall colour');
    A.eq(rm.wallMat || 'plating', f.walls.mat, id + ': ' + q.name + ' has the palette walls');
  }
  const hall = st.rooms().filter(x => x.kind === 'corridor');
  A.ok(hall.length && hall.every(h => h.floorStyle === th.corridor.style), id + ': every corridor has the palette deck');
  A.ok(hall.every(h => (h.wallMat || 'plating') === th.corridor.walls.mat), id + ': every corridor has the palette walls');
  const hub = st.rooms().find(x => x.name === 'HOME' || x.kind === 'bridge');
  A.ok(hub && hub.floorStyle === th.work.deck.style, id + ': the main room joins the palette');
  st.undo();
  A.eq(snap(st), before, id + ': one undo takes the whole station back');
}

/* ---- a composed room leaves no floor sealed off, seats face a table, and required equipment stays ---- */
for (const style of STYLES) {
  const st = fresh();
  const pl = SB.planBuild(st.serialize(), { layout: { pattern: 'diamond', rooms: [{ name: 'A ROOM', style }] }, replace: true }, env);
  A.ok(pl.ok, style + ': plans (' + (pl.error || '') + ')');
  if (!pl.ok) continue;
  const r = SB.apply(st, pl.plan, env);
  A.ok(r.ok, style + ': builds (' + (r.error || '') + ')');
  if (!r.ok) continue;
  const rm = room(st, 'A ROOM');
  if (!rm) { A.ok(false, style + ': stands'); continue; }
  const cr = SD.critiqueRoom(st, env, rm, id => []);
  A.ok(cr.metrics.coverage >= 0.12, style + ': the floor holds something (' + cr.metrics.coverage + ')');
  A.ok(!cr.findings.some(f => /sealed|cannot be reached|no way/i.test(f)), style + ': no sealed floor (' + cr.findings.join(' | ') + ')');
  const pieces = st.props().filter(p => { const b = rm.rects[0]; return p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2; });
  const must = SD.RECIPES[style].must;
  if (must) A.ok(pieces.some(p => (Array.isArray(must.needs) ? must.needs : [must.needs]).some(n => new RegExp(n).test(p.t))), style + ': keeps its equipment');
}

/* ---- starting from a prebuild ---- */
for (const c of T.catalog) {
  const kits = T.presetKits(c.id);
  if (!kits.length) continue;
  const st = fresh(), before = snap(st);
  const pl = SB.planBuild(st.serialize(), { layout: { from: c.id, theme: 'flagship', rooms: [{ name: 'EXTRA WING', style: 'cafe' }] }, replace: true }, env);
  A.ok(pl.ok, c.id + ': a layout can start from it (' + (pl.error || '') + ')');
  if (!pl.ok) continue;
  A.ok(pl.plan.rooms.some(r => r.name === 'EXTRA WING'), c.id + ': with the room the design adds');
  const r = SB.apply(st, pl.plan, env);
  A.ok(r.ok, c.id + ': builds (' + (r.error || '') + ')');
  if (!r.ok) continue;
  const lined = SD.prebuildRooms(T, c.id).filter(x => x.lines);
  A.ok(st.props().filter(p => p.t === 'intake').length >= lined.length, c.id + ': its lines are laid');
  for (const q of lined) A.ok(room(st, q.name), c.id + ': its line room ' + q.name + ' stands');
  st.undo();
  A.eq(snap(st), before, c.id + ': one undo');
}
{
  const st = fresh();
  const bad = SB.planBuild(st.serialize(), { layout: { from: 'nope', rooms: [] }, replace: true }, env);
  A.ok(!bad.ok && /no prebuild "nope"/.test(bad.error), 'an unknown prebuild names the real ones');
  const badT = SB.planBuild(st.serialize(), { layout: { theme: 'zzz', rooms: ROOMS }, replace: true }, env);
  A.ok(!badT.ok && /no theme "zzz"/.test(badT.error) && /noir/.test(badT.error), 'an unknown theme names the real ones');
}

/* ---- sizes are honoured on the diamond, so a station can have a heart ---- */
{
  const st = fresh();
  const pl = SB.planBuild(st.serialize(), { layout: { pattern: 'diamond', rooms: [{ name: 'HEART', style: 'lounge', size: { w: 22, h: 14 } }, { name: 'STORE', style: 'storage', size: 'small' }, { name: 'LAB', style: 'lab' }] }, replace: true }, env);
  A.ok(pl.ok, 'mixed sizes plan (' + (pl.error || '') + ')');
  if (pl.ok) {
    A.ok(SB.apply(st, pl.plan, env).ok, 'mixed sizes build');
    const area = n => { const b = room(st, n).rects[0]; return (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1); };
    A.ok(area('HEART') > area('LAB') && area('LAB') > area('STORE'), 'the heart is bigger than the rest, the store smaller');
    const cov = SD.critiqueRoom(st, env, room(st, 'HEART'), () => []).metrics.coverage;
    A.ok(cov >= 0.2, 'a big room is furnished to its size, not one group on a big floor (' + cov + ')');
  }
}

/* ---- a station laid out afresh dresses its main room, without moving what works there ---- */
{
  const st = fresh();
  const kept = st.props().filter(p => /desk/.test(p.t)).map(p => p.id);
  const pl = SB.planBuild(st.serialize(), { layout: { rooms: ROOMS }, replace: true }, env);
  A.ok(SB.apply(st, pl.plan, env).ok, 'a fresh layout builds');
  const hub = st.rooms().find(x => x.kind === 'bridge' || x.name === 'HOME'), b = hub.rects[0];
  const inHub = st.props().filter(p => p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2);
  A.ok(inHub.some(p => p.t === 'holotable' || p.t === 'bigscreen'), 'the main room has a heart of its own');
  A.ok(kept.every(id => st.propById(id)), 'the desks that worked there still stand');
}

/* ---- a Commander changes their mind: one station after another, each over the last ---- */
{
  const st = fresh();
  const seq = [{ theme: 'noir', rooms: ROOMS }, { theme: 'neon', rooms: ROOMS }, { pattern: 'concourse', theme: 'timber', rooms: ROOMS.slice(0, 4) }, { theme: 'biolab', rooms: ROOMS }, { rooms: ROOMS }];
  seq.forEach((layout, i) => {
    const pl = SB.planBuild(st.serialize(), { layout, replace: true }, env);
    A.ok(pl.ok, 'station ' + (i + 1) + ' of the sequence plans (' + (pl.error || '') + ')');
    if (pl.ok) A.ok(SB.apply(st, pl.plan, env).ok, 'station ' + (i + 1) + ' of the sequence builds');
  });
  const hub = st.rooms().find(x => x.kind === 'bridge' || x.name === 'HOME'), b = hub.rects[0];
  A.eq(st.props().filter(p => p.t === 'holotable' && p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2).length, 1, 'the main room is dressed once, not once per station');
}

/* ---- the architectures: each one really is another plan, and each one stands up ---- */
{
  const PLANS = ['axis', 'enfilade', 'colony', 'campus', 'pinwheel'];
  const LINE = [{ name: 'WORKS', lines: [{ line: 'build_test' }] }];
  const prints = {};
  const ringOf = st => { const h = st.rooms().find(x => x.kind === 'bridge' || x.name === 'HOME').rects[0]; return st.rooms().filter(r => r.kind === 'corridor').some(c => { const q = c.rects[0]; return q.x1 <= h.x1 - 4 && q.x2 >= h.x2 + 4; }); };
  for (const pattern of PLANS) {
    for (const rooms of [ROOMS, ROOMS.slice(0, 2), ROOMS.concat(LINE)]) {
      const st = fresh(), before = snap(st), tag = pattern + ' with ' + rooms.length + ' rooms';
      const pl = SB.planBuild(st.serialize(), { layout: { pattern, rooms }, replace: true }, env);
      A.ok(pl.ok, tag + ': plans (' + (pl.error || '') + ')');
      if (!pl.ok) continue;
      A.eq(SB.planBuild(st.serialize(), { layout: { pattern, rooms }, replace: true }, env).plan.resultSig, pl.plan.resultSig, tag + ': the same request plans the same station');
      const r = SB.apply(st, pl.plan, env);
      A.ok(r.ok, tag + ': builds (' + (r.error || '') + ')');
      if (!r.ok) continue;
      A.ok(new RegExp(pattern, 'i').test(pl.plan.summary), tag + ': the card names the plan');
      A.ok(!ringOf(st), tag + ': there is no ring round the main room');
      const g = st.projectGeometry(), hub = st.rooms().find(x => x.name === 'HOME').rects[0];
      // the floor as the crew walks it, from wherever the main room has clear floor
      let start = null;
      for (let yy = hub.y1; yy <= hub.y2 && !start; yy++) for (let xx = hub.x1; xx <= hub.x2 && !start; xx++) if (g.walkable(xx - g.origin.tx, yy - g.origin.ty)) start = [xx - g.origin.tx, yy - g.origin.ty];
      const seen = new Set([start.join()]), todo = [start];
      while (todo.length) { const [x, y] = todo.pop(); for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = (x + a) + ',' + (y + b); if (!seen.has(k) && g.walkable(x + a, y + b) && g.canStep(x, y, x + a, y + b)) { seen.add(k); todo.push([x + a, y + b]); } } }
      for (const q of rooms) { const rm = room(st, q.name); A.ok(rm, tag + ': ' + q.name + ' stands'); }
      {
        if (rooms === ROOMS) prints[pattern] = st.rooms().filter(x => x.kind !== 'corridor').map(x => { const b = x.rects[0]; return [x.name, b.x1 - hub.x1, b.y1 - hub.y1, b.x2 - b.x1, b.y2 - b.y1].join(); }).sort().join('|');
        const found = st.rooms().filter(x => x.kind !== 'corridor' && x.name !== 'HOME');
        for (const x of found) { const b = x.rects[0]; let reach = false; for (let yy = b.y1; yy <= b.y2 && !reach; yy++) for (let xx = b.x1; xx <= b.x2 && !reach; xx++) if (seen.has((xx - g.origin.tx) + ',' + (yy - g.origin.ty))) reach = true; A.ok(reach, tag + ': ' + x.name + ' can be walked to from the main room'); }
      }
      st.undo();
      A.eq(snap(st), before, tag + ': one undo');
    }
  }
  A.eq(new Set(Object.values(prints)).size, PLANS.length, 'all five plans are different floors');
  // the plain default stays what it was; a palette brings its own plan
  const bareD = SB.planBuild(fresh().serialize(), { layout: { rooms: ROOMS }, replace: true }, env);
  A.ok(/DIAMOND/.test(bareD.plan.summary), 'no palette and no plan: still the diamond');
  for (const id of SD.THEME_ORDER) {
    const t = SB.planBuild(fresh().serialize(), { layout: { theme: id, rooms: ROOMS }, replace: true }, env);
    A.ok(t.ok && new RegExp(SD.THEMES[id].plan, 'i').test(t.plan.summary), id + ': takes its own plan, ' + SD.THEMES[id].plan + ' (' + (t.error || '') + ')');
  }
  // a Commander changing their mind across plans, and a room added afterwards
  const st = fresh();
  for (const pattern of PLANS.concat(['diamond', 'concourse', 'colony'])) {
    const pl = SB.planBuild(st.serialize(), { layout: { pattern, rooms: pattern === 'concourse' ? ROOMS.slice(0, 4) : ROOMS }, replace: true }, env);
    A.ok(pl.ok, 'from one plan to ' + pattern + ' (' + (pl.error || '') + ')');
    if (pl.ok) A.ok(SB.apply(st, pl.plan, env).ok, pattern + ' builds over the last');
  }
  const more = SB.planBuild(st.serialize(), { rooms: [{ name: 'ANNEX', style: 'cozy' }] }, env);
  A.ok(more.ok, 'a room can still be added to a colony (' + (more.error || '') + ')');
  for (const c of T.catalog) if (T.presetKits(c.id).length) for (const pattern of PLANS) {
    const pl = SB.planBuild(fresh().serialize(), { layout: { from: c.id, pattern }, replace: true }, env);
    A.ok(pl.ok, c.id + ' as a ' + pattern + ' (' + (pl.error || '') + ')');
  }
  const big = SB.planBuild(fresh().serialize(), { layout: { pattern: 'colony', rooms: Array.from({ length: 16 }, (_, k) => ({ name: 'R' + k, style: 'lounge' })) }, replace: true }, env);
  A.ok(big.ok, 'a big colony grows (' + (big.error || '') + ')');
  const over = SB.planBuild(fresh().serialize(), { layout: { pattern: 'campus', rooms: Array.from({ length: 13 }, (_, k) => ({ name: 'R' + k, style: 'lounge' })) }, replace: true }, env);
  A.ok(!over.ok && /holds 12/.test(over.error), 'a campus says what it holds');
  A.ok(SB.mapOf(fresh().serialize(), env, { guide: true }).map.architectures.length === 7, 'the guide offers all seven plans');
}

/* ---- retheme: materials only, not one piece moves ---- */
{
  const st = fresh();
  A.ok(SB.apply(st, SB.planBuild(st.serialize(), { layout: { pattern: 'diamond', rooms: ROOMS }, replace: true }, env).plan, env).ok, 'fixture station');
  const pieces = JSON.stringify(st.props().map(p => [p.id, p.t, p.x, p.y])), before = snap(st);
  const pl = SB.planEdit(st.serialize(), { retheme: 'moody noir' }, env);
  A.ok(pl.ok, 'retheme plans (' + (pl.error || '') + ')');
  A.ok(/NOIR/.test(pl.plan.summary), 'the summary names the palette');
  A.ok(SB.apply(st, pl.plan, env).ok, 'retheme builds');
  A.eq(JSON.stringify(st.props().map(p => [p.id, p.t, p.x, p.y])), pieces, 'no piece moved');
  A.ok(st.rooms().filter(r => r.kind === 'corridor').every(r => r.floorStyle === SD.THEMES.noir.corridor.style), 'the hallways took the palette');
  A.ok(st.rooms().filter(r => r.kind !== 'corridor').every(r => r.hullMat === SD.THEMES.noir.hull.mat || r.wallMat), 'the rooms took the palette');
  st.undo();
  A.eq(snap(st), before, 'one undo takes the palette off');
  const no = SB.planEdit(st.serialize(), { retheme: 'zzz' }, env);
  A.ok(!no.ok && /Themes:/.test(no.error), 'an unknown palette names the real ones');
}

/* ---- the review: real findings, on plans and floors, in a size a model can read ---- */
{
  const st = fresh();
  const doc = st.serialize();
  const pl = SB.planBuild(doc, { layout: { pattern: 'diamond', theme: 'observatory', rooms: ROOMS }, replace: true }, env);
  const rev = SB.reviewPlan(doc, pl.plan, env);
  A.ok(rev && typeof rev.score === 'number' && rev.grade, 'a plan gets a review');
  A.eq(snap(st), JSON.stringify(doc), 'reviewing changes nothing');
  A.ok(JSON.stringify(rev).length < 2500, 'the review stays short (' + JSON.stringify(rev).length + ')');
  A.ok(rev.station.some(f => /same size/.test(f)), 'six rooms of one size are called out');
  // a bare room is rough, and says so
  const bare = fresh();
  const made = SB.planBuild(bare.serialize(), { rooms: [{ name: 'EMPTY', size: 'large' }] }, env);
  A.ok(made.ok, 'an empty room plans (' + (made.error || '') + ')');
  if (made.ok) {
    SB.apply(bare, made.plan, env);
    const r = SB.review(bare.serialize(), env, { room: 'EMPTY' });
    A.ok(r && r.rooms[0] && r.rooms[0].fix.length > 0, 'an empty room has something to fix');
  }
}

/* ---- the guide, and the tools' surface ---- */
{
  const m = SB.mapOf(fresh().serialize(), env, { guide: true });
  A.ok(m.ok && m.map.principles.length >= 8, 'the guide has its principles');
  A.eq(m.map.themes.length, SD.THEME_ORDER.length, 'the guide lists every palette');
  A.ok(m.map.prebuilds.length >= 3 && m.map.prebuilds.every(p => p.id && p.name), 'the guide lists the prebuilds');
  A.ok(typeof makeStationTools === 'function', 'the tools load');
}

A.report('station-design');
