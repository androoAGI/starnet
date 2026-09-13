'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCanvas, Image } = require('@napi-rs/canvas');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'frontend/app/industrialtextures.js'), 'utf8');
async function load(search, broken = false) {
  class AssetImage extends Image {
    set src(url) {
      if (broken && url.includes('wall.png')) { queueMicrotask(() => this.onerror()); return; }
      super.src = fs.readFileSync(path.join(root, 'frontend', url));
    }
  }
  const document = { documentElement: { dataset: {} }, createElement: () => createCanvas(1, 1) };
  const context = { Image: AssetImage, document, location: { search }, URLSearchParams, module: { exports: {} } };
  vm.runInNewContext(source, context);
  await context.module.exports.ready;
  return context.module.exports;
}
(async () => {
  const pack = await load('');
  assert.equal(pack.enabled(), true);
  const cv = createCanvas(80, 80), raw = cv.getContext('2d');
  raw.translate(7, 9);
  const g = pack.detailContext(raw);
  g.fillStyle = '#555'; g.fillRect(0, 0, 30, 30);
  g.save(); g.beginPath(); g.rect(4, 4, 20, 20); g.clip();
  const gradient = g.createLinearGradient(0, 0, 20, 0);
  gradient.addColorStop(0, '#f00'); gradient.addColorStop(1, '#00f');
  g.fillStyle = gradient; g.fillRect(0, 0, 30, 30); g.restore();
  g.globalCompositeOperation = 'destination-out'; g.fillRect(10, 10, 4, 4);
  g.globalCompositeOperation = 'source-over'; g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#fff'; g.fillRect(50, 50, 5, 5);
  const result = createCanvas(80, 80), rg = result.getContext('2d');
  assert.equal(pack.drawBase(rg, cv), true);
  const alpha = (c, x, y) => c.getImageData(x, y, 1, 1).data[3];
  let samples = 0;
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
    assert.equal(alpha(raw, x, y) > 127, alpha(rg, x, y) > 127, 'geometry alpha at ' + x + ',' + y);
    samples++;
  }
  const a = createCanvas(24, 12), b = createCanvas(24, 12);
  pack.floor(a.getContext('2d'), 0, 0, 12, -1, -1); pack.floor(a.getContext('2d'), 12, 0, 12, 0, -1);
  pack.floor(b.getContext('2d'), 0, 0, 12, 7, 7); pack.floor(b.getContext('2d'), 12, 0, 12, 8, 7);
  assert.deepEqual(a.getContext('2d').getImageData(0, 0, 24, 12).data, b.getContext('2d').getImageData(0, 0, 24, 12).data);
  const missing = await load('?textures=industrial', true);
  assert.equal(missing.enabled(), false); assert.equal(missing.status().failed[0], 'wall');
  const normal = await load('?textures=classic'); assert.equal(normal.enabled(), false);
  assert.equal(normal.detailContext(raw), raw);
  // Verify real prop integration: every facing uses its own art, occupied chair
  // rims match those pixels exactly, and the desk preserves its image aspect.
  const propContext = { module: { exports: {} }, IndustrialTextures: pack,
    document: { createElement: () => createCanvas(1, 1) }, console,
    U: { hash: s => String(s).split('').reduce((h,c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0, shade: c => c } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'frontend/app/propsprites.js'), 'utf8'), propContext);
  const props = propContext.module.exports, facings = new Set();
  for (const fallback of [normal, missing]) {
    const fallbackContext={ ...propContext, IndustrialTextures:fallback, module:{exports:{}} };
    vm.runInNewContext(fs.readFileSync(path.join(root,'frontend/app/propsprites.js'),'utf8'),fallbackContext);
    assert.equal(fallbackContext.module.exports.spec('desk').w,2,'fallback retains original catalogue dimensions');
  }
  for (let r = 0; r < 4; r++) for (let m = 0; m < 2; m++) {
    const full = createCanvas(36, 40), front = createCanvas(36, 40);
    const f = { t: 'chair', x: 1, y: 1, w: 1, h: 1, r, m: !!m };
    props.setCtx(full.getContext('2d')); props.draw(f, false);
    props.setCtx(front.getContext('2d')); props.drawSeatFront(f);
    const pixels = c => c.getContext('2d').getImageData(12, 18, 12, 3).data;
    assert.deepEqual(pixels(full), pixels(front), 'occupied rim agrees with facing ' + r + '/' + m);
    facings.add(Buffer.from(full.getContext('2d').getImageData(0, 0, 36, 40).data).toString('base64'));
    assert.equal(front.getContext('2d').getImageData(0, 0, 36, 18).data.some(v => v), false, 'front pass leaves head clear');
    assert.equal(full.getContext('2d').getImageData(0, 24, 36, 16).data.some(v => v), false, 'chair grounded within its tile');
  }
  assert.ok(facings.size >= 4, 'four distinct chair views');
  const calls = [], spy = { save() {}, restore() {}, drawImage(...args) { calls.push(args); } };
  assert.equal(props.spec('desk').w, 3, 'new industrial desk has its real three-tile footprint');
  assert.equal(props.spec('desk2').w, 3);
  pack.workstation(spy, 12, 12, 36, 12);
  const [im, dx, dy, dw, dh] = calls[0];
  assert.ok(Math.abs(dw / dh - im.width / im.height) < 1e-8, 'no workstation stretching');
  assert.equal(dy + dh, 24, 'desk contacts its original floor line');
  assert.ok(dx >= 11 && dx + dw <= 49, 'desk fits its new footprint');
  assert.ok(dw >= 37 && dh >= 23 && dh <= 23.5, 'broader console retains approved height');
  pack.workstation(spy,12,12,24,12);
  const [legacy,lx,ly,lw,lh]=calls[1];
  assert.ok(lw <= 26 && lh >= 23 && lh <= 23.5, 'saved two-tile desks retain height within their footprint');
  assert.ok(Math.abs(lw/lh-legacy.width/legacy.height)<1e-8);
  assert.equal(ly+lh,24);
  // New bridge furniture must reserve its visible width and remain grounded.
  for (const [id, name] of [['bridge_consolebank','console-bank'], ['bridge_tacticaltable','tactical-table'], ['bridge_equipmentbay','equipment-bay']]) {
    const s=props.spec(id), draws=[], painter={save(){},restore(){},drawImage(...args){draws.push(args);}};
    pack.furniture(painter,name,12,36,s.w*12,s.h*12);
    const [art,px,py,pw,ph]=draws[0];
    assert.equal(py+ph,36+s.h*12,id+' grounded');
    assert.ok(px>=12 && px+pw<=12+s.w*12+1e-8,id+' does not spill into adjacent tiles');
    assert.ok(pw>=s.w*12*.95,id+' fills its footprint');
    assert.ok(Math.abs(pw/ph-art.width/art.height)<1e-8,id+' keeps source proportions');
    assert.equal(s.tier,'cosmetic',id+' does not claim tools');
  }
  for (const edition of [pack,normal,missing]) {
    const env={...propContext,IndustrialTextures:edition,module:{exports:{}}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'frontend/app/propsprites.js'),'utf8'),env);
    const sprites=env.module.exports;
    for (const id of ['bridge_consolebank','bridge_tacticaltable','bridge_equipmentbay','bridge_deckperimeter']) {
      const s=sprites.spec(id),c=createCanvas(192,192);
      sprites.setCtx(c.getContext('2d')); sprites.draw({t:id,x:2,y:4,w:s.w,h:s.h},false);
      assert.ok(c.getContext('2d').getImageData(0,0,192,192).data.some(v=>v),id+' has art even when textures fail');
      if (s.flat) assert.equal(alpha(c.getContext('2d'),24+s.w*6,48+s.h*6),0,'perimeter center is transparent');
    }
  }
  const wm=require(path.join(root,'frontend/app/worldmodel.js'));
  wm.setPropRules(props.spec);
  const station=wm.defaultDoc();
  station.rooms.r1.rects=[{x1:0,y1:0,x2:21,y2:17}];
  station.props=require('./command-deck.cjs')();
  const model=wm.deserialize(station);
  for (const p of station.props) assert.equal(model.canPlaceProp(p.t,p.x,p.y,p.w,p.h,p.id).ok,true,'valid preview placement '+p.id);
  assert.equal(model.canPlaceProp('bridge_consolebank',2,2,9,1).error,'NEEDS_WALL','bank requires its actual north wall');
  const geometry=model.projectGeometry(),ox=geometry.origin.tx,oy=geometry.origin.ty;
  let reachable=0;
  for(let y=0;y<18;y++) for(let x=0;x<22;x++) if(geometry.walkable(x-ox,y-oy)) {
    assert.ok(geometry.path(11-ox,16-oy,x-ox,y-oy),'all free deck remains reachable at '+x+','+y);reachable++;
  }
  assert.ok(geometry.walkable(5-ox,8-oy),'perimeter stripe is walkable');
  assert.equal(geometry.walkable(10-ox,8-oy),false,'table footprint blocks walking');
  const strip = pack.wallStrip(39);
  assert.equal(strip.hi.w, strip.w * 6);
  assert.equal(strip.hi.h, strip.h * 6);
  const wall = createCanvas(60, 48), base = wall.getContext('2d'), dense = pack.detailContext(base);
  dense.fillStyle = '#444'; dense.fillRect(4, 4, 48, 39);
  const before = base.getImageData(0, 0, 60, 48).data;
  pack.wallPatch(dense, 4, 4, 48, 39, strip, (x,y) => ({ a:x-4, d:y-4+.5 }));
  assert.deepEqual(base.getImageData(0, 0, 60, 48).data, before, 'detailed side/corner art leaves geometry authority untouched');
  const visible = createCanvas(60, 48), vg = visible.getContext('2d');
  pack.drawBase(vg, wall);
  for (let y=0;y<48;y++) for(let x=0;x<60;x++)
    assert.equal(alpha(base,x,y)>127, alpha(vg,x,y)>127, 'wall patch silhouette at '+x+','+y);
  // A straight projection through the corner sampler must reproduce the north
  // wall's bay, instead of magnifying a 48px colour strip into blurry blocks.
  const straight = createCanvas(60,48), sg=pack.detailContext(straight.getContext('2d'));
  for(let i=0;i<4;i++) pack.wall(sg,4+i*12,4,12,39,i);
  const northView = createCanvas(60,48); pack.drawBase(northView.getContext('2d'),straight);
  let error=0,count=0;
  const projected=vg.getImageData(4,4,48,39).data, north=northView.getContext('2d').getImageData(4,4,48,39).data;
  for(let i=0;i<projected.length;i++) if(i%4!==3) {error+=Math.abs(projected[i]-north[i]);count++;}
  assert.ok(error/count<12, 'straight and wrapped walls agree in tone and UV phase; mean error '+error/count);
  // The shell passes through nested source-atop / destination-in canvases. Its
  // dense art must survive each blit while low-resolution masks stay unchanged.
  for (const args of [[0,0], [0,0,60,48], [0,0,60,48,0,0,60,48]]) {
    const layer=createCanvas(60,48), lg=pack.detailContext(layer.getContext('2d'));
    lg.fillStyle='#fff'; lg.fillRect(0,0,60,48);
    lg.globalCompositeOperation='source-atop'; lg.drawImage(straight,...args);
    lg.globalCompositeOperation='destination-in'; lg.drawImage(straight,0,0);
    const output=createCanvas(60,48); pack.drawBase(output.getContext('2d'),layer);
    assert.deepEqual(output.getContext('2d').getImageData(0,0,60,48).data,
      northView.getContext('2d').getImageData(0,0,60,48).data,'nested shell retains detailed art and mask');
  }
  console.log(JSON.stringify({ assets: pack.status(), alphaSamples: samples, chairOrientations: 8,
    seatFrontPixelMatch: 'PASS', workstationAspect: 'PASS', floorContact: 'PASS',
    wallGeometry: 'PASS', shellDetailAndMasks: 'PASS', wallContinuityMeanError: +(error/count).toFixed(2),
    worldAnchor: 'PASS', missingAssetFallback: 'PASS', normalRenderer: 'PASS', bridgeFootprints: 'PASS',
    bridgeFallbacks: 'PASS', perimeterAlpha: 'PASS', reachableDeckTiles: reachable }));
})().catch(err => { console.error(err); process.exitCode = 1; });
