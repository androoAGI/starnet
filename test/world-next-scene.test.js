'use strict';
const A = require('./_assert.js');
const Scene = require('../frontend/world-next/scene.js');
const CanonicalModel = require('../frontend/app/worldmodel.js');
function station(closed = false) {
  return { order: ['left', 'hall', 'right'], meta: { trunkRoomId: 'left' }, rooms: {
    left: { name: 'Sanctuary', kind: 'quarters', rects: [{ x1: -4, y1: -2, x2: -1, y2: 1 }] },
    hall: { kind: 'corridor', rects: [{ x1: 0, y1: -1, x2: 1, y2: 0 }] },
    right: { kind: 'lab', rects: [{ x1: 2, y1: -2, x2: 5, y2: 1 }] }
  }, props: [{ id: 'lock', t: 'airlock', x: 3, y: 0, w: 1, h: 1, door: closed ? 'closed' : 'open' }], belts: { '0,0': 'e', '1,0': 'e' } };
}
const open = Scene.project(station()), closed = Scene.project(station(true));
A.eq(Scene.TILE, 32, 'the independent world uses the new 32px tile scale');
A.eq(Scene.WALL, 48, 'standing architecture uses the new 48px proportion');
A.eq(open.tiles.size, 36, 'arbitrary negative-coordinate rooms and connector rectangles project to a floor union');
A.ok(open.chunkTiles.has('-1,-1') && open.chunkTiles.has('0,0'), 'chunk addressing preserves negative world coordinates');
A.eq(Scene.tileAt(-1, -33), { x: -1, y: -2 }, 'ground picking floors negative coordinates instead of truncating toward zero');
A.eq(Scene.tileAt(32, 64), { x: 1, y: 2 }, 'ground picking uses exact tile boundaries');
A.ok(Scene.canCross(open, -1, 0, 0, 0), 'a real room/corridor join remains open');
A.ok(!Scene.canCross(open, -1, -2, 0, -2), 'an absent corridor tile remains a solid exterior boundary');
A.ok(Scene.canCross(open, 1, 0, 2, 0), 'an open airlock allows crossing into its room');
A.ok(!Scene.canCross(closed, 1, 0, 2, 0), 'the actual closed airlock seals its room boundary');
A.ok(Scene.canCross(closed, 3, 0, 4, 0), 'sealing a room does not obstruct movement inside it');
A.eq(open.edges.filter(e => !e.exterior).length, 0, 'open joins do not grow decorative walls across the floor');
A.eq(closed.edges.filter(e => !e.exterior).length, 2, 'a sealed two-tile threshold emits one wall face per tile without duplicates');
const source = { x: -80, y: 16, r: 400 };
A.ok(Scene.visible(open, source, 144, 16), 'light can reach the next room through the actual corridor');
A.ok(!Scene.visible(closed, source, 144, 16), 'light stops at the closed airlock instead of passing through architecture');
A.ok(!Scene.visible(open, source, 144, -60), 'a diagonal ray that leaves the corridor is occluded');
A.ok(!Scene.visible(open, source, -200, 16), 'outer space receives no interior source light');
const diagonal = Scene.project({ rooms: { a: { rects: [{ x1: 0, y1: 0, x2: 0, y2: 0 }] }, b: { rects: [{ x1: 1, y1: 1, x2: 1, y2: 1 }] } } });
A.ok(!Scene.visible(diagonal, { x: 16, y: 16, r: 100 }, 48, 48), 'light cannot squeeze through touching diagonal corners');
const raised = { x: -80, y: -72, originX: -80, originY: -48, r: 80 };
A.ok(Scene.visible(open, raised, -80, -24), 'raised visible sources use a separate floor-plane origin for wall visibility');
const polygon = Scene.visibility(closed, source);
A.ok(polygon.length >= 72, 'light visibility includes a radial contour and wall corner rays');
A.ok(polygon.every(p => p.x < 64), 'every closed-door visibility vertex stays on the source side');
const box = Scene.bounds(open);
A.eq([box.minTx, box.minTy, box.maxTx, box.maxTy], [-4, -2, 5, 1], 'bounds retain the raw station extents');
A.ok(box.x <= -4 * 32 - 17 && box.y <= -2 * 32 - 48 && box.y + box.height >= 2 * 32 + 28,
  'camera bounds include tall north architecture and the south cutaway face');
A.ok(Number.isFinite(Scene.bounds({}).cx), 'an empty station still has usable camera bounds');
A.ok(Scene.material({ name: 'Botanical Garden' }).botanical, 'botanical architectural treatment follows the actual room identity');
A.eq(Object.keys(Scene.STYLE_COLORS).sort(), Object.keys(CanonicalModel.FLOOR_STYLES).sort(), 'every persisted finish has a new scene pigment');
A.eq(Object.keys(Scene.MATERIALS).sort(), Object.keys(CanonicalModel.FLOOR_MATERIALS).sort(), 'every persisted floor material has a new scene recipe');
const editable = CanonicalModel.create(station());
A.ok(editable.setDeck('left', { style: 'cobalt', mat: 'plank' }).ok, 'canonical whole-room deck update succeeds');
const roomFinish = editable.doc().rooms.left;
A.eq([Scene.material(roomFinish).style, Scene.material(roomFinish).recipe], ['cobalt', 'plank'], 'new scene reads both axes of the canonical setDeck result');
A.ok(editable.paintTiles('left', [[-3, 0]], 'ember').ok, 'canonical tile paint accepts world coordinates');
A.eq(Scene.material(roomFinish, -3, 0).style, 'ember', 'painted negative-coordinate tile uses its saved override');
A.eq(Scene.material(roomFinish, -2, 0).style, 'cobalt', 'neighboring unpainted tile retains the room finish');
A.eq(Scene.material(roomFinish, -3, 0).recipe, 'plank', 'tile paint changes color while retaining the independently selected material');
editable.setDeck('left', { style: 'bone' });
A.eq(Scene.material(roomFinish, -3, 0).style, 'bone', 'a whole-room repaint visibly clears the old tile override');
A.eq(Scene.material({ kind: 'bridge', floorMat: null }).recipe, CanonicalModel.ROOM_KINDS.bridge.mat, 'null material follows the canonical room-kind default');

// Canvas command adapter exercises the new composition API, invalidation and sort
// without pretending that commands establish live raster appearance.
let allocations = 0;
const contexts = [];
function canvasFactory(w, h) {
  allocations++;
  const stack = [], g = { globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false, commands: [],
    lost: false, isContextLost() { return this.lost; }, setTransform() {}, clearRect() {}, fillRect(...v) { this.commands.push(['rect', this.fillStyle, ...v]); }, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, rect() {}, clip() {}, fill() { this.commands.push(['fill', this.fillStyle]); }, stroke() { this.commands.push(['stroke', this.strokeStyle]); },
    drawImage() {}, translate() {}, rotate() {},
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); }
  }; contexts.push(g);
  return { width: w, height: h, getContext: () => g };
}
const canvas = canvasFactory(800, 600), scene = Scene.create(canvas, { canvasFactory }), doc = station();
const drawn = [], art = {
  drawProp(ctx, prop, now, state) { drawn.push({ id: prop.id, working: state.working }); },
  drawAgent(ctx, agent) { drawn.push({ id: agent.id }); }
};
const frame = { station: doc, width: 800, height: 600, dpr: 1, now: 100, reducedMotion: true,
  agents: [{ id: 'crew', x: -2.5, y: 0.5, working: true }],
  props: [{ id: 'desk', t: 'desk', x: -3, y: 0, w: 2, h: 1, agentId: 'crew' }]
};
A.ok(scene.draw(frame, art), 'the independent scene renders a raw station through its supplied art adapter');
A.eq(drawn.map(d => d.id), ['crew', 'desk'], 'characters and furniture sort by feet rather than source array order');
A.eq(drawn[1].working, true, 'workstation activity is derived from the supplied real working-agent state');
const first = scene.stats(), allocated = allocations;
scene.draw(frame, art);
A.eq(scene.stats().geometryBuilds, first.geometryBuilds, 'steady frames retain the projected topology');
A.eq(scene.stats().chunkBuilds, first.chunkBuilds, 'steady frames retain floor textures');
A.eq(scene.stats().lightBuilds, first.lightBuilds, 'steady light fields are composited from cache');
A.eq(allocations, allocated, 'steady frames allocate no new canvas surfaces');
drawn.length = 0;
scene.draw(Object.assign({}, frame, { agents: [{ id: 'crew', x: -2.5, y: 0.5, working: false }] }), art);
A.eq(drawn.find(d => d.id === 'desk').working, false, 'ending real work clears the art adapter state on the next frame');
const builds = scene.stats().geometryBuilds;
doc.props[0].door = 'closed'; scene.draw(Object.assign({}, frame, { revision: 1 }), art);
A.eq(scene.stats().geometryBuilds, builds + 1, 'a station revision rebuilds topology after an in-place door edit');
const replacementDoc = station(true);
scene.draw(Object.assign({}, frame, { station: replacementDoc, revision: 1 }), art);
A.eq(scene.stats().geometryBuilds, builds + 2, 'a new raw station object invalidates all layout-dependent caches');
const chunksBeforeLoss = scene.stats().chunkBuilds;
contexts[contexts.length - 1].lost = true; scene.draw(Object.assign({}, frame, { station: replacementDoc, revision: 1 }), art);
A.ok(scene.stats().chunkBuilds > chunksBeforeLoss, 'the scene repaints a lost surface even when the document and revision stay unchanged');
scene.dispose();
A.eq(scene.stats().chunks, 0, 'dispose releases cached floor and lighting surfaces');
A.eq(scene.draw(frame, art), false, 'a disposed scene does not draw');
function renderedFloor(style, mat) {
  const cv = canvasFactory(400, 300), s = Scene.create(cv, { canvasFactory });
  const floorContextIndex = contexts.length;
  s.draw({ station: { rooms: { r: { floorStyle: style, floorMat: mat, rects: [{ x1: 0, y1: 0, x2: 5, y2: 3 }] } } }, width: 400, height: 300, reducedMotion: true });
  const signature = JSON.stringify(contexts[floorContextIndex].commands); s.dispose(); return signature;
}
const materialSignatures = Object.keys(Scene.MATERIALS).map(m => renderedFloor('sterile', m));
A.eq(new Set(materialSignatures).size, Object.keys(Scene.MATERIALS).length, 'all eighteen material choices issue visibly distinct floor drawing commands');
A.ok(renderedFloor('cobalt', 'plank') !== renderedFloor('ember', 'plank'), 'changing saved finish changes the actual floor paint commands');
A.report('World Next independent scene');
