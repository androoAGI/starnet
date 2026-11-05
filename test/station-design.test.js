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
const STYLES = Object.keys(SD.RECIPES).filter(k => k !== 'bridge' && k !== 'court');   // the main room's and the square's recipes are no style a room can ask for
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
  const PLANS = ['axis', 'enfilade', 'colony', 'campus', 'pinwheel', 'court', 'terrace'];
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
  A.eq(new Set(Object.values(prints)).size, PLANS.length, 'every plan is a different floor');
  // a palette brings its own plan
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
  // every plan grows on: a room added with no place asked follows the plan and palette the station was laid out in, and what stood stays
  for (const pattern of PLANS) {
    const g = fresh(), first = SB.planBuild(g.serialize(), { layout: { pattern, theme: 'noir', rooms: ROOMS.slice(0, 5) }, replace: true }, env);
    A.ok(first.ok && SB.apply(g, first.plan, env).ok, pattern + ': the first part builds');
    A.eq(g.serialize().meta.stationPlan.pattern, pattern, pattern + ': the station remembers its plan');
    const reread = M.create(JSON.parse(JSON.stringify(g.serialize())));
    A.eq(reread.serialize().meta.stationPlan.theme, 'noir', pattern + ': the memory survives a save');
    for (const [name, req] of [['ANNEX', { rooms: [{ name: 'ANNEX', style: 'cozy' }] }], ['ANNEX 2', { rooms: [{ name: 'ANNEX 2', style: 'storage' }] }]]) {
      const was = JSON.stringify(g.rooms().filter(r => r.name !== name && r.kind !== 'corridor').map(r => [r.name, r.rects]));
      const on = SB.planBuild(g.serialize(), req, env);
      A.ok(on.ok && on.plan.layout && on.plan.layout.pattern === pattern, pattern + ': ' + name + ' follows the plan (' + (on.error || (on.plan.notes || []).join(' ')) + ')');
      A.ok(on.ok && SB.apply(g, on.plan, env).ok, pattern + ': ' + name + ' builds');
      A.eq(JSON.stringify(g.rooms().filter(r => r.name !== name && r.kind !== 'corridor').map(r => [r.name, r.rects])), was, pattern + ': what stood has not moved');
      const added = room(g, name);
      A.eq(added && added.floorStyle, SD.THEMES.noir[SD.FAMILY[name === 'ANNEX' ? 'cozy' : 'storage']].deck.style, pattern + ': ' + name + ' wears the palette');
    }
  }
  // a retheme keeps the memory true; a room with a place asked goes there, whatever the plan
  {
    const g = fresh(), first = SB.planBuild(g.serialize(), { layout: { pattern: 'colony', theme: 'noir', rooms: ROOMS.slice(0, 3) }, replace: true }, env);
    SB.apply(g, first.plan, env);
    const re = SB.planEdit(g.serialize(), { retheme: 'timber' }, env);
    A.ok(re.ok && SB.apply(g, re.plan, env).ok, 'retheme builds (' + (re.error || '') + ')');
    A.eq(g.serialize().meta.stationPlan.theme, 'timber', 'a retheme updates the memory');
    A.eq(g.serialize().meta.stationPlan.pattern, 'colony', 'and keeps the plan');
    // a retheme keeps what was painted, moves the old palette's inlay to the new accent, and keeps each room in its family
    {
      const q = fresh(), a1 = SB.planBuild(q.serialize(), { layout: { pattern: 'colony', theme: 'noir', rooms: [{ name: 'PATCH', style: 'garden' }, { name: 'DANCE', style: 'games' }] }, replace: true }, env);
      SB.apply(q, a1.plan, env);
      const d0 = room(q, 'DANCE'), b0 = d0.rects[0], hand = [[b0.x2, b0.y2], [b0.x2 - 1, b0.y2]];
      q.paintTiles(d0.id, hand, 'violet');
      const inlay = Object.keys(room(q, 'DANCE').floorPaint || {}).filter(k => room(q, 'DANCE').floorPaint[k] === SD.THEMES.noir.accent).length;
      const r2 = SB.planEdit(q.serialize(), { retheme: 'timber' }, env);
      A.ok(r2.ok && SB.apply(q, r2.plan, env).ok, 'the painted station rethemes (' + (r2.error || '') + ')');
      const paint = room(q, 'DANCE').floorPaint || {};
      A.ok(hand.every(([x, y]) => paint[x + ',' + y] === 'violet'), 'what was painted by hand survives a retheme');
      A.eq(Object.values(paint).filter(v => v === SD.THEMES.timber.accent).length >= inlay, true, 'the inlay takes the new accent');
      A.eq(room(q, 'PATCH').floorStyle, SD.THEMES.timber.green.deck.style, 'a garden keeps the green floor of the new palette');
    }
    // rooms named alike share a pod on a campus
    {
      const q = fresh(), pl = SB.planBuild(q.serialize(), { layout: { pattern: 'campus', rooms: [{ name: 'BIO LAB', style: 'lab' }, { name: 'CHEM LAB', style: 'lab' }, { name: 'BIO DESKS', style: 'desks' }, { name: 'CHEM DESKS', style: 'desks' }, { name: 'LIBRARY', style: 'library' }, { name: 'ARCHIVE', style: 'storage' }] }, replace: true }, env);
      A.ok(pl.ok && SB.apply(q, pl.plan, env).ok, 'a named campus builds');
      const c = n => { const b = room(q, n).rects[0]; return [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2]; }, dist = (a, b) => Math.hypot(c(a)[0] - c(b)[0], c(a)[1] - c(b)[1]);
      A.ok(dist('BIO LAB', 'BIO DESKS') < dist('BIO LAB', 'CHEM DESKS'), 'a team sits together');
      // a hall can be read by name, and the floor map says what stands in it
      const hallName = q.rooms().find(r => r.kind === 'corridor').name, read = SB.mapOf(q.serialize(), env, { room: hallName });
      A.ok(read.ok, 'a corridor can be read by name (' + (read.error || '') + ')');
      A.ok(SB.mapOf(q.serialize(), env, {}).map.halls.every(h => typeof h.furniture === 'number'), 'the floor map counts what stands in a corridor');
    }
    // what the code review found: no empty pod, the main room's inlay kept under a palette, another plan named is not grown as this one
    {
      const q = fresh(), pl = SB.planBuild(q.serialize(), { layout: { pattern: 'campus', rooms: [{ name: 'BIO LAB', style: 'lab' }, { name: 'BIO DESKS', style: 'desks' }, { name: 'BIO STORE', style: 'storage' }] }, replace: true }, env);
      A.ok(pl.ok && SB.apply(q, pl.plan, env).ok, 'one team on a campus builds');
      A.eq((SB.strandedHalls ? SB.strandedHalls(q) : []).length, 0, 'no plaza or bridge leads nowhere');
      const n = fresh(), pn = SB.planBuild(n.serialize(), { layout: { pattern: 'diamond', theme: 'noir', rooms: ROOMS.slice(0, 2) }, replace: true }, env);
      SB.apply(n, pn.plan, env);
      const hubPart = pn.plan.spec.build.parts.find(p => p.restyle);
      if (hubPart && hubPart.paint && hubPart.paint.length) A.ok(Object.keys(n.rooms().find(r => r.id === hubPart.roomId).floorPaint || {}).length > 0, 'the main room keeps its inlay under a palette');
      const d = fresh(), pd = SB.planBuild(d.serialize(), { layout: { pattern: 'diamond', rooms: ROOMS.slice(0, 2) }, replace: true }, env);
      SB.apply(d, pd.plan, env);
      const ax = SB.planBuild(d.serialize(), { layout: { pattern: 'axis', rooms: [{ name: 'X1', style: 'cozy' }] } }, env);
      if (ax.ok) { SB.apply(d, ax.plan, env); A.eq(d.serialize().meta.stationPlan.pattern, 'diamond', 'a diamond added to stays a diamond'); A.ok(!/more room on the AXIS/.test(ax.plan.summary), 'the card does not call it a grown axis'); }
      else A.ok(/axis around HOME could not be laid|Use replace: true/.test(ax.error), 'another plan beside a diamond refuses in plain words: ' + ax.error);
    }
    // the tidy never boxes a piece in, and never pushes one out through a door into the new corridor (from the second review's probes)
    for (const [pattern, setup] of [['axis', [['plant', 17, 5], ['plant', 16, 9], ['plant', 17, 8], ['plant', 17, 10]]], ['axis', [['plant', 17, 5], ['plant', 16, 1], ['plant', 17, 1], ['plant', 16, 8], ['plant', 17, 8], ['plant', 16, 9], ['plant', 17, 9], ['plant', 16, 10], ['plant', 17, 10], ['plant', 16, 0]]], ['concourse', [['plant', 17, 5], ['plant', 16, 1], ['plant', 17, 1], ['plant', 16, 8], ['plant', 17, 8], ['plant', 16, 9], ['plant', 17, 9], ['plant', 16, 10], ['plant', 17, 10], ['plant', 16, 0]]]]) {
      const q = fresh(), ids = setup.map(([t, x, y]) => { const r = q.addProp({ t, x, y, w: 1, h: 1, r: 0, block: true }); return r && r.ok ? r.id : null; });
      const hubId = q.serialize().meta.spawnRoomId;
      const pl = SB.planBuild(q.serialize(), { layout: { pattern, rooms: [{ name: 'LOUNGE', style: 'lounge' }, { name: 'LAB', style: 'lab' }] }, replace: true }, env);
      if (!pl.ok) { A.ok(true, pattern + ': refused, nothing to tidy'); continue; }
      A.ok(SB.apply(q, pl.plan, env).ok, pattern + ': the tidied plan applies');
      for (const m of pl.plan.spec.moves || []) {
        const p = q.propById(m.id); if (!p || ids.indexOf(m.id) < 0) continue;
        A.eq(q.roomAt(p.x, p.y), hubId, pattern + ': a moved piece stays in the main room');
      }
      const rv = SB.review(q.serialize(), env), home = (rv.rooms || []).find(r => r.name === 'HOME');
      A.ok(!home || !(home.fix || []).some(f => /cannot be reached|walled in|could not be walked/.test(f)), pattern + ': nothing in the main room is walled in');
    }
    // the main room stands no piece alone, whatever plan it hosts; the review catches a room stamped twice
    {
      const q = fresh(), pl = SB.planBuild(q.serialize(), { layout: { pattern: 'terrace', rooms: ROOMS }, replace: true }, env);
      SB.apply(q, pl.plan, env);
      const home = (SB.review(q.serialize(), env).rooms || []).find(r => r.name === 'HOME');
      A.ok(!home || !(home.fix || []).some(f => /floats alone/.test(f)), 'no piece floats in the main room: ' + (home ? home.fix.join(' ') : ''));
    }
    const un = M.create(JSON.parse(JSON.stringify(g.serialize())));
    const rearr = SB.planEdit(g.serialize(), { rearrange: 'diamond' }, env);
    if (rearr.ok) { const h = M.create(JSON.parse(JSON.stringify(g.serialize()))); A.ok(SB.apply(h, rearr.plan, env).ok, 'a rearrange builds'); A.eq(h.serialize().meta.stationPlan.pattern, 'diamond', 'a rearranged station is a diamond'); }
    const swap = SB.planRoom(un.serialize(), { preset: 'research', replace: true }, env);
    if (swap.ok) { A.ok(SB.apply(un, swap.plan, env).ok, 'a preset goes in'); A.ok(!un.serialize().meta.stationPlan, 'a preset forgets the old plan'); }
    const placed = SB.planBuild(g.serialize(), { rooms: [{ name: 'EAST WING', style: 'cozy', beside: 'HOME', side: 'north' }] }, env);
    A.ok(!placed.ok || !placed.plan.layout, 'a place asked is not overruled by the plan');
  }
  // rooms of one style differ within a station, and every variant of every style builds
  for (const style of STYLES.filter(k => SD.VARIANTS[k])) {
    const g = fresh(), rooms = [0, 1, 2].map(k => ({ name: style.toUpperCase() + ' ' + k, style }));
    const pl = SB.planBuild(g.serialize(), { layout: { pattern: 'colony', rooms: rooms.map(r => Object.assign({ size: { w: 20, h: 14 } }, r)) }, replace: true }, env);
    A.ok(pl.ok, style + ': three of them plan (' + (pl.error || '') + ')');
    if (!pl.ok) continue;
    A.ok(SB.apply(g, pl.plan, env).ok, style + ': three of them build');
    const prints = rooms.map(r => { const id = room(g, r.name).id; return g.props().filter(p => g.roomAt(p.x, p.y) === id).map(p => p.t).sort().join(); });
    A.eq(new Set(prints).size, 3, style + ': three rooms, three different furnishings');
    const rv = SB.review(g.serialize(), env);
    for (const r of (rv && rv.rooms) || []) A.ok(!(r.fix || []).some(f => /lies on the bare floor/.test(f)), style + ': nothing lies on the floor in ' + r.name + ': ' + (r.fix || []).join(' '));
    const must = SD.RECIPES[style].must;
    if (must) for (const r of rooms) { const id = room(g, r.name).id; A.ok(must.needs.every(t => g.props().some(p => p.t === t && g.roomAt(p.x, p.y) === id)), style + ': ' + r.name + ' keeps its real equipment'); }
  }
  // a replace moves the main room's pieces clear of its new doors, and one undo puts them back
  for (const pattern of PLANS.concat(['diamond'])) {
    const g = fresh(), was = snap(g), pl = SB.planBuild(g.serialize(), { layout: { pattern, rooms: ROOMS }, replace: true }, env);
    A.ok(pl.ok && SB.apply(g, pl.plan, env).ok, pattern + ': builds');
    const hub = g.rooms().find(r => r.id === (g.serialize().meta || {}).spawnRoomId);
    const home = (SB.review(g.serialize(), env).rooms || []).find(r => r.name === hub.name);
    const crowded = home ? (home.fix || []).filter(f => /crowds the doorway/.test(f)) : [];
    A.eq(crowded.length, 0, pattern + ': nothing crowds a door of the main room: ' + crowded.join(' '));
    A.ok(was, pattern + ': had a floor');
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
  A.ok(SB.mapOf(fresh().serialize(), env, { guide: true }).map.architectures.length === 9, 'the guide offers all nine plans');
  A.ok(SB.mapOf(fresh().serialize(), env, { guide: true }).map.rooms.styles.length === RS.ROOM_ORDER.length, 'the guide lists every room style');
  // the words a real model reached for when it had not been told the styles
  for (const [word, want] of [['hall', 'lounge'], ['gallery', 'library'], ['club', 'games'], ['workroom', 'desks']]) A.eq(RS.resolveRoom(word), want, word + ' finds its nearest style');
  // with no palette, what the rooms are for chooses the plan, and says so
  {
    const pick = rooms => SB.planBuild(fresh().serialize(), { layout: { rooms }, replace: true }, env);
    const say = (rooms, want) => { const r = pick(rooms); A.ok(r.ok && r.plan.layout.pattern === want && r.plan.notes.some(n => /No plan was named/.test(n)), 'plain rooms choose ' + want + ': ' + (r.ok ? r.plan.layout.pattern : r.error)); };
    const of = (...st) => st.map((style, k) => ({ name: 'R' + k, style }));
    say(of('lounge', 'library'), 'enfilade');
    say(of('lounge', 'cafe', 'garden', 'library', 'games'), 'colony');
    say(of('desks', 'lab', 'workshop', 'comms'), 'axis');
    say(of('desks', 'lab', 'workshop', 'comms', 'meeting', 'desks'), 'campus');
    say(of('desks', 'lab', 'lounge', 'cafe', 'garden', 'workshop'), 'court');
    const named = SB.planBuild(fresh().serialize(), { layout: { pattern: 'diamond', rooms: of('lounge', 'cafe') }, replace: true }, env);
    A.ok(named.ok && named.plan.layout.pattern === 'diamond', 'a named ring is still a ring');
    const beside = SB.planBuild(fresh().serialize(), { layout: { rooms: of('lounge') } }, env);
    A.ok(beside.ok && beside.plan.layout.pattern === 'diamond', 'adding beside what stands keeps the grid');
  }
  // the grade: one poor room keeps a station from finished
  A.eq(SD.gradeOf(90, 80), 'finished', 'a good station is finished');
  A.eq(SD.gradeOf(90, 45), 'getting there', 'one poor room stops it being finished');
  A.eq(SD.gradeOf(50, 45), 'rough', 'a poor station is rough');
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
