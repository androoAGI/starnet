/* Whole-catalog industrial construction coverage. The raster review is separate; this
 * protects mode fallback, authored facings, footprint stability and paint commands. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
let clean = false, fitWhenReady;
global.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.document = { addEventListener() {}, documentElement: { style: { setProperty() {} } }, createElement: () => ({ getContext: () => null, style: {} }) };
global.U = new Function(fs.readFileSync(path.join(__dirname, '../frontend/js/util.js'), 'utf8') + ';return U;')();
global.IndustrialTextures = { isRemaster: () => clean, enabled: () => false, ready: { then(fn){fitWhenReady=fn;} }, workstation: () => false, chair: () => false, furniture: () => false };
const PS = require('../frontend/app/propsprites.js');
function paint(p, mode, r = 0) {
  clean = mode;
  const marks = [], noop = () => {}, g = new Proxy({ fillStyle: '', globalAlpha: 1,
    fillRect(x,y,w,h) { if(w>0&&h>0) marks.push([x,y,w,h,this.fillStyle,this.globalAlpha]); },
    createLinearGradient: () => ({ addColorStop: noop }), measureText: () => ({ width: 0 }), getImageData: () => ({ data: [] }) },
    { get(target,key) { return key in target ? target[key] : noop; } });
  PS.setCtx(g); PS.setNow(2400);
  const fp = PS.footprintAt(p.id,r);
  // Warm the existing own-hue outline cache before comparing modes.
  for(let i=0;i<2;i++){marks.length=0;PS.draw({ t:p.id,x:3,y:4,w:fp.w,h:fp.h,r,id:'audit' },false);}
  return marks.map(m => m.join(',')).join(';');
}
let checked=0;
for(const p of PS.CATALOG) {
  const original = paint(p,false), remaster = paint(p,true);
  A.ok(original.length>0 && remaster.length>0,p.id+': both modes paint');
  A.ok(original!==remaster,p.id+': industrial material/construction reaches this prop');
  A.eq(paint(p,false),original,p.id+': returning to classic restores the exact paint');
  const base = {w:p.w,h:p.h};
  clean=true;A.eq(PS.footprintAt(p.id,0),base,p.id+': finish never resizes the footprint');
  for(const r of PS.facings(p.id)) A.ok(paint(p,true,r).length>0,p.id+': offered facing '+r+' paints');
  checked++;
}
const fresh=PS.CATALOG.filter(p=>p.id.startsWith('industrial_'));
A.eq(fresh.length,12,'twelve distinct matching props');
for(const p of fresh){
  A.eq(p.tier,'cosmetic',p.id+': no invented capability');
  A.ok(Number.isInteger(p.w)&&Number.isInteger(p.h)&&p.w>0&&p.h>0,p.id+': explicit grid footprint');
  if(p.flat) A.ok(p.blocks===false&&!p.surface&&!p.mount&&!p.use,p.id+': paint has no body or seat');
  if(p.surface) A.eq(p.h,1,p.id+': shared tabletop rise only applies to one-row tables');
}
A.eq(PS.footprintAt('industrial_partition',3),{w:1,h:3},'partition profile reserves its real plan');
A.eq(PS.facings('industrial_locker'),[0],'upright cabinet never rotates its elevation');
A.eq(PS.facings('industrial_bench'),[0],'bench retains the existing south couch seating contract');
A.eq(PS.spec('industrial_wallpanel').mount,'wall','service panel requires its real wall host');
A.eq(PS.spec('industrial_toolcaddy').stack,true,'caddy supports floor and tabletop mounting');
// Loaded directional assets are the sole functional-facing exception. The
// generated workstation chair uses the same cardinal art as its operator.
for(const id of ['desk','desk2','seatchair']) {
  clean=false;A.eq(PS.facings(id),[0],id+': old pack retains south-only behavior');
  clean=true;A.eq(PS.facings(id),[0,1,2,3],id+': remaster offers four authored directions');
  A.eq(PS.viewAt(id,1).mirror,1,id+': west is mirrored east, never a spun elevation');
  A.eq(PS.viewAt(id,3).turned,0,id+': east art is not rotated twice');
}
for(const id of ['bay','outbox','intake','console','consoleL','workbench']) A.eq(PS.facings(id),[0],id+': no unrelated functional rotation');
const requested=[];
global.IndustrialTextures.workstation=(ctx,x,y,w,h,face='s')=>{requested.push(face);return true;};
global.IndustrialTextures.chair=(ctx,x,y,w,h,face='s')=>{requested.push(face);return true;};
for(const id of ['desk','desk2','seatchair']) for(const [r,face] of [[0,'s'],[1,'e'],[2,'n'],[3,'e']]){
  requested.length=0;PS.setCtx({save(){},restore(){},translate(){},scale(){}});PS.setNow(2400);
  PS.draw({t:id,x:0,y:0,w:id==='seatchair'?1:2,h:1,r},false);
  A.eq(requested,[face],id+': routes facing '+r+' to the matching source');
}
clean=false;
// Screen centroids come from the same atlas-fit helper as the visible prop.
const emitterCalls=[];
global.IndustrialTextures.workstationEmitter=(x,y,w,h,facing)=>{
  emitterCalls.push({x,y,w,h,facing});
  if(facing==='n')return null;
  return {x:x+w*(facing==='e'?.3:.6),y:y-(facing==='e'?7:6)};
};
clean=true;
for(const t of ['desk','desk2'])for(const w of [2,3])for(const mount of [undefined,'surface']){
  const X=48,Y=84-(mount?8:0),W=w*12,H=12;
  for(const [r,m,ratio,source] of [[0,0,.6,'s'],[0,1,.4,'s'],[1,0,.7,'e'],[1,1,.3,'e'],[3,0,.3,'e'],[3,1,.7,'e']]){
    const f={t,x:4,y:7,w,h:1,r,m,mount},light=PS.lightOf(f,true,true);
    A.ok(Math.abs(light.x-(X+W*ratio))<1e-8,t+': measured screen reflects exactly once '+r+'/'+m+'/'+w);
    A.eq(light.y,Y-(source==='e'?7:6),t+': mount lift applied once to screen point');
    A.eq(emitterCalls.at(-1),{x:X,y:Y,w:W,h:H,facing:source},t+': same draw rectangle reaches atlas helper');
    A.eq(light.r,PS.EMIT[t].r,t+': source alignment retains light reach');
    A.eq(light.a,PS.EMIT[t].a,t+': source alignment retains truthful brightness');
  }
  A.eq(PS.lightOf({t,x:4,y:7,w,h:1,r:2,mount},true,true),null,t+': rear has no forward monitor glow');
}
let before=emitterCalls.length;
A.eq(PS.lightOf({t:'desk',x:1,y:1,w:3,h:1,r:3},false,true),null,'idle workstation still emits nothing');
A.eq(emitterCalls.length,before,'idle work gate runs before screen measurement');
clean=false;
A.eq(PS.lightOf({t:'desk',x:4,y:7,w:2,h:1,r:3},true,true).x,60,'classic retains old centered source');
A.eq(emitterCalls.length,before,'classic never asks for remastered geometry');
clean=true;
for(const t of ['bay','intake','outbox','console','core','airlock']){
  const f={t,x:4,y:7,w:2,h:2,r:3};clean=false;const original=PS.lightOf(f,true,true);
  clean=true;A.eq(PS.lightOf(f,true,true),original,t+': unrelated status emitter unchanged');
}
global.IndustrialTextures.workstationEmitter=()=>null;
A.eq(PS.lightOf({t:'desk',x:4,y:7,w:2,h:1,r:3},true,true),null,'explicit no-screen result never falls back');
global.IndustrialTextures.workstationEmitter=()=>({x:NaN,y:4});
A.eq(PS.lightOf({t:'desk',x:4,y:7,w:2,h:1,r:3},true,true),null,'invalid measured source emits nothing');
delete global.IndustrialTextures.workstationEmitter;
A.eq(PS.lightOf({t:'desk',x:4,y:7,w:2,h:1,r:3},true,true).x,57,'missing helper gets an east-facing compatibility anchor');
A.eq(PS.lightOf({t:'desk',x:4,y:7,w:2,h:1,r:1},true,true).x,63,'missing helper gets the reflected west-facing anchor');
A.eq(PS.lightOf({t:'desk',x:4,y:7,w:2,h:1,r:2},true,true),null,'compatibility path never invents a rear screen');
// Decorative illumination converges on cyan/amber; material pigments and real
// status LEDs were excluded above. Count authored pink pixels before and after.
function pinkPaint(sig){return [...sig.matchAll(/#([0-9a-f]{6})/gi)].filter(m=>{
  const n=parseInt(m[1],16),r=n>>>16,g=n>>8&255,b=n&255;
  return r>g*1.35&&b>g*1.25&&r>50&&b>40;
}).length;}
for(const id of ['djbooth','arcade','lavalamp','plasmaglobe']){
  const p=PS.spec(id),original=pinkPaint(paint(p,false)),now=pinkPaint(paint(p,true));
  A.ok(original>0&&now<original,id+': bright magenta decorative paint reduced');
  clean=true;A.eq(PS.lightOf({t:id,x:1,y:1,w:p.w,h:p.h},true,true).c,[70,155,165],id+': bounced light agrees with cyan artwork');
}
function broadLuma(sig){return sig.split(';').map(r=>r.split(',')).filter(r=>+r[2]>=20&&+r[3]>=5&&/^#[0-9a-f]{6}$/i.test(r[4])).map(r=>{
 const n=parseInt(r[4].slice(1),16);return ((n>>>16)+(n>>8&255)+(n&255))/3;
});}
const board=PS.spec('whiteboard');
A.ok(Math.max(...broadLuma(paint(board,true)))<Math.max(...broadLuma(paint(board,false))),'broad whiteboard sheet is aged off-white instead of a bright luminous slab');
// Raster grain is optional, scoped to machinery casing planes, and painted
// before native service hardware. Missing/unavailable grain preserves fallback.
const panelCalls=[];
for(const id of ['industrial_locker','industrial_drawerbank','industrial_supplycart','industrial_partition','industrial_servicecab','console','war_intelcab','comms_uplink','safe']){
  delete global.IndustrialTextures.propPanel;
  const p=PS.spec(id),without=paint(p,true),original=paint(p,false);
  global.IndustrialTextures.propPanel=(ctx,x,y,w,h,c)=>{panelCalls.push({id,x,y,w,h,c});return false;};
  A.eq(paint(p,true),without,id+': unavailable panel texture keeps exact native fallback');
  A.ok(panelCalls.some(q=>q.id===id),id+': authored casing plane requests grain');
  const count=panelCalls.length;
  A.eq(paint(p,false),original,id+': grain hook leaves classic paint byte-identical');
  A.eq(panelCalls.length,count,id+': classic never requests new materials');
}
for(const q of panelCalls){
  A.ok(q.w>=7&&q.h>=3&&[q.x,q.y,q.w,q.h].every(Number.isFinite),q.id+': grain is confined to a finite usable face');
  A.ok(['#3d4240','#565b54','#2c3838','#45514e'].includes(q.c),q.id+': grain receives casing metal, never an emissive or cloth color');
}
let count=panelCalls.length;
for(const id of ['plant','tallplant','bunk','whiteboard','research_papers','lavalamp','plasmaglobe'])paint(PS.spec(id),true);
A.eq(panelCalls.length,count,'natural surfaces, linen, paper and light volumes never request gunmetal grain');
const locker=PS.spec('industrial_locker');
delete global.IndustrialTextures.propPanel;const nativeLocker=paint(locker,true);
global.IndustrialTextures.propPanel=()=>{throw new Error('material unavailable');};
A.eq(paint(locker,true),nativeLocker,'optional material failure preserves every native hardware command');
const order=[];
global.IndustrialTextures.propPanel=(ctx,x,y,w,h,c)=>{order.push('grain');return true;};
const orderedCtx=new Proxy({fillRect(){order.push('hardware');},createLinearGradient:()=>({addColorStop(){}}),measureText:()=>({width:0})},{get:(o,k)=>k in o?o[k]:()=>{}});
PS.setCtx(orderedCtx);PS.setNow(2400);clean=true;PS.draw({t:'industrial_locker',x:3,y:4,w:2,h:1},false);
for(let i=0;i<order.length;i++)if(order[i]==='grain')A.ok(order[i-1]==='hardware'&&order[i+1]==='hardware','grain layers between casing paint and service hardware');
delete global.IndustrialTextures.propPanel;
// Desk width is physical tabletop length. A quarter turn reserves that length
// along depth; fixed standing height belongs to the atlas draw, never the grid.
for(const id of ['desk','desk2'])A.eq(PS.footprintAt(id,0),{w:2,h:1},id+': unavailable pack retains compact catalog');
global.IndustrialTextures.enabled=()=>true;fitWhenReady();
for(const id of ['desk','desk2'])A.eq(PS.footprintAt(id,0),{w:3,h:1},id+': loaded pack retains broad catalog augmentation');
const WM = require('../frontend/app/worldmodel.js');
const PA = require('../frontend/app/propanchor.js');
WM.setPropRules(id=>PS.spec(id));
for(const t of ['desk','desk2']){
  const catalog=PS.spec(t),straight={w:catalog.w,h:catalog.h},side={w:catalog.h,h:catalog.w};
  clean=false;
  for(const r of [0,1,2,3])A.eq(PS.footprintAt(t,r),straight,t+': classic never re-tiles '+r);
  clean=true;
  for(const r of [0,1,2,3])A.eq(PS.footprintAt(t,r),r&1?side:straight,t+': remaster reserves rotated tabletop '+r);
  // Existing compact workstations keep their physical length, as the builder's
  // before/after footprint relationship determines whether actual w/h swap.
  for(const length of [2,3])for(const r of [1,3]){
    const st=WM.create(WM.defaultDoc()),added=st.addProp({t,x:5,y:4,w:length,h:1,block:true});
    A.ok(added.ok,t+': starts on a real floor');
    const initial=st.serialize(),before=PS.footprintAt(t,0),after=PS.footprintAt(t,r);
    A.ok(before.w===after.h&&before.h===after.w,t+': catalog relationship signals actual footprint swap');
    const p=st.propById(added.id),turn=st.faceProp(p.id,r,{w:p.h,h:p.w});
    A.ok(turn.ok,t+': real rotation succeeds on clear floor');
    A.eq([p.w,p.h],[1,length],t+': actual physical length preserved after turn');
    A.eq(st.propAt(5,4+length-1),p.id,t+': picking reaches the far end of the deep desk');
    A.eq(st.propAt(6,4),null,t+': former wide tile is released for picking');
    const geo=st.projectGeometry(),local=geo.props.find(q=>q.id===p.id);
    A.eq([local.w,local.h,local.r],[1,length,r],t+': renderer receives actual rotated plan');
    let drawn;global.IndustrialTextures.workstation=(ctx,x,y,w,h,face)=>{drawn={w,h,face};return true;};
    PS.setCtx({save(){},restore(){},translate(){},scale(){}});PS.draw(local,false);
    A.eq(drawn,{w:12,h:length*12,face:'e'},t+': side artwork receives actual depth and fixed narrow plan');
    A.ok(!geo.walkable(local.x,local.y+length-1),t+': pathfinding blocks the whole desk depth');
    A.ok(geo.walkable(local.x+1,local.y),t+': old wide footprint becomes walkable');
    const seat=PA.deriveAnchor(local,geo,{approach:'front',sit:true});
    A.eq([seat.tx,seat.ty,seat.face],[local.x+(r===1?-1:1),local.y+Math.floor(length/2),r===1?'east':'west'],t+': operator approaches the centre of the actual long edge');
    A.ok(geo.walkable(seat.tx,seat.ty),t+': chosen chair tile is walkable');
    const roundtrip=WM.deserialize(st.serialize()).propById(p.id);
    A.eq([roundtrip.w,roundtrip.h,roundtrip.r],[1,length,r],t+': saved plan survives migration');
    st.undo();A.eq(st.serialize(),initial,t+': one undo restores footprint and facing');
  }
  // New placement, overlap rejection and deck bounds all use the same turned box.
  const st=WM.create(WM.defaultDoc()),box=PS.footprintAt(t,3);
  const placed=st.addProp({t,x:4,y:4,w:box.w,h:box.h,r:3,block:true});
  A.ok(placed.ok,t+': new side-facing placement accepts the rotated catalog dimensions');
  A.eq([st.propById(placed.id).w,st.propById(placed.id).h],[side.w,side.h],t+': new placement occupies its actual depth tiles');
  const crowded=WM.create(WM.defaultDoc()),desk=crowded.addProp({t,x:5,y:4,w:3,h:1});
  crowded.addProp({t:'crate',x:5,y:5,w:1,h:1});
  const unchanged=crowded.serialize(),denied=crowded.faceProp(desk.id,3,box);
  A.ok(!denied.ok,t+': obstruction at the far end refuses the turn');
  A.eq(crowded.serialize(),unchanged,t+': failed turn changes neither facing nor size');
  const edge=WM.create(WM.defaultDoc()),near=edge.addProp({t,x:5,y:10,w:3,h:1});
  A.ok(near.ok&&!edge.faceProp(near.id,1,PS.footprintAt(t,1)).ok,t+': rotation cannot extend off the deck');
}
WM.setPropRules(null);
clean=false;
A.report('prop-industrial-remaster ('+checked+' props)');
