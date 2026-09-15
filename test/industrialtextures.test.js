'use strict';
// Public loader/render contracts, using tiny synthetic RGBA assets. This does not
// judge generated artwork or browser antialiasing; those need the live preview.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const Surface = require('../frontend/app/worldsurface.js');
const source = fs.readFileSync(require.resolve('../frontend/app/industrialtextures.js'), 'utf8');
let checks = 0;
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };
const near = (a, b, message) => ok(Math.abs(a - b) < 1e-7, message);
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const color = value => {
  if (/^#[\da-f]{6}$/i.test(value)) { const n = parseInt(value.slice(1), 16); return [n >>> 16, (n >>> 8) & 255, n & 255, 255]; }
  const m = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!m) return [0, 0, 0, 0];
  const parts = m[1].split(',').map(Number); return [parts[0], parts[1], parts[2], Math.round((parts[3] == null ? 1 : parts[3]) * 255)];
};
function canvas(w = 1, h = 1) {
  let width = w, height = h, pixels = new Uint8ClampedArray(w*h*4);
  const cv = { draws: [], fills: [], paths: new Set(), reads: 0 }, stack = [];
  let state = { matrix: [1,0,0,1,0,0], fillStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none' };
  Object.defineProperties(cv, {
    width: { get: () => width, set: v => { width = v; pixels = new Uint8ClampedArray(width*height*4); } },
    height: { get: () => height, set: v => { height = v; pixels = new Uint8ClampedArray(width*height*4); } },
    pixels: { get: () => pixels }
  });
  function paint(x, y, rw, rh, sample) {
    const m = state.matrix, x0 = m[0]*x+m[4], y0 = m[3]*y+m[5], sw = rw*m[0], sh = rh*m[3];
    for (let yy = Math.max(0, Math.floor(y0)); yy < Math.min(height, Math.ceil(y0+sh)); yy++)
      for (let xx = Math.max(0, Math.floor(x0)); xx < Math.min(width, Math.ceil(x0+sw)); xx++) {
        const rgba = sample((xx+.5-x0)/sw, (yy+.5-y0)/sh), i = (yy*width+xx)*4;
        const alpha = rgba[3]/255 * state.globalAlpha;
        if (state.globalCompositeOperation === 'color') {
          // The nonseparable color blend retains destination luminance. A neutral
          // paint alone therefore cannot darken or lighten an existing texture.
          const luma = .3*pixels[i] + .59*pixels[i+1] + .11*pixels[i+2];
          const srcLuma = .3*rgba[0] + .59*rgba[1] + .11*rgba[2];
          for (let k = 0; k < 3; k++) pixels[i+k] = pixels[i+k]*(1-alpha) + Math.max(0, Math.min(255, rgba[k]+luma-srcLuma))*alpha;
        } else {
          for (let k = 0; k < 3; k++) pixels[i+k] = rgba[k]*alpha + pixels[i+k]*(1-alpha);
          pixels[i+3] = (alpha + pixels[i+3]/255*(1-alpha))*255;
        }
      }
  }
  const ctx = { canvas: cv, save() { stack.push({ ...state, matrix: state.matrix.slice() }); }, restore() { state = stack.pop(); },
    getTransform: () => ({ a:state.matrix[0], b:state.matrix[1], c:state.matrix[2], d:state.matrix[3], e:state.matrix[4], f:state.matrix[5] }),
    scale(x,y) { state.matrix = mul(state.matrix,[x,0,0,y,0,0]); },
    transform(...m) { state.matrix = mul(state.matrix,m); }, setTransform(...m) { state.matrix = m; }, resetTransform() { state.matrix = [1,0,0,1,0,0]; },
    beginPath() {}, rect() {}, clip() {},
    drawImage(image, ...args) {
      let sx=0,sy=0,sw=image.width,sh=image.height,dx,dy,dw,dh;
      if (args.length===2) [dx,dy,dw,dh]=[...args,sw,sh];
      else if (args.length===4) [dx,dy,dw,dh]=args;
      else [sx,sy,sw,sh,dx,dy,dw,dh]=args;
      cv.draws.push({ image, sx,sy,sw,sh,dx,dy,dw,dh, filter:state.filter });
      for (const p of image.paths || [image.src]) if (p) cv.paths.add(p);
      const gain = /brightness\(([\d.]+)\)/.exec(state.filter), factor = gain ? Number(gain[1]) : 1;
      paint(dx,dy,dw,dh,(u,v) => {
        const x=Math.min(image.width-1,Math.max(0,Math.floor(sx+u*sw))), y=Math.min(image.height-1,Math.max(0,Math.floor(sy+v*sh)));
        const p=(y*image.width+x)*4, d=image.pixels;
        return [Math.min(255,d[p]*factor),Math.min(255,d[p+1]*factor),Math.min(255,d[p+2]*factor),d[p+3]];
      });
    },
    fillRect(x,y,w,h) { const c=color(state.fillStyle); cv.fills.push({ x,y,w,h,color:state.fillStyle }); paint(x,y,w,h,()=>c); },
    getImageData(x,y,w,h) {
      cv.reads++;
      const data=new Uint8ClampedArray(w*h*4);
      for(let yy=0;yy<h;yy++) for(let xx=0;xx<w;xx++) {
        const from=((y+yy)*width+x+xx)*4, to=(yy*w+xx)*4;
        data.set(pixels.slice(from,from+4),to);
      }
      return {data,width:w,height:h};
    },
    createLinearGradient: () => ({ addColorStop() {} })
  };
  for (const key of ['fillStyle','globalAlpha','globalCompositeOperation','filter']) Object.defineProperty(ctx,key,{get:()=>state[key],set:v=>{state[key]=v;}});
  cv.getContext=()=>ctx; cv.addEventListener=()=>{}; return cv;
}
function fixtureAsset(url, darkScreens) {
  const side=url.endsWith('/workstation-e.png'), compact=url.includes('workstation-compact');
  const isDesk=url.includes('workstation');
  const w=isDesk ? side ? 24 : compact ? 32 : 48 : 64;
  const h=isDesk ? side ? 48 : compact ? 24 : 30 : url.includes('/walls/') ? 48 : 64;
  const pixels=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const i=(y*w+x)*4;
    pixels.set(isDesk ? [48,44,35,255] : [25+x%70,30+y%70,36+(x+y)%60,255],i);
  }
  const points=[{x:5,y:4,weight:80},{x:Math.floor(w*.6),y:Math.floor(h*.4),weight:160}];
  if(isDesk&&!darkScreens) {
    for(const p of points) pixels.set([0,p.weight,p.weight,255],(p.y*w+p.x)*4);
    pixels.set([0,250,250,100],(w+2)*4); // translucent blue must not be a screen source
    pixels.set([180,180,180,255],(2*w+2)*4); // white trim must not be a screen source
    pixels.set([180,90,20,255],(3*w+2)*4); // amber hardware must not be a screen source
  }
  return {width:w,height:h,pixels,points};
}
function load({classic=false,fail,darkScreens=false,review=false}={}) {
  const requests=[], pending=[], assets=new Map(), dataset={};
  class Image {
    set src(url) { this.url=url; Object.assign(this,fixtureAsset(url,darkScreens)); requests.push(url); pending.push(this); assets.set(url,this); }
    get src() { return this.url; }
  }
  const scope={ module:{exports:{}}, URLSearchParams, location:{search:'?textures='+(classic?'classic':'industrial')+(review?'&propReview=crate':'')}, Image,
    document:{documentElement:{dataset},createElement:()=>canvas()} };
  vm.runInNewContext(source,scope,{filename:'industrialtextures.js'});
  return {api:scope.module.exports,requests,assets,dataset,async finish() {
    for(const image of pending) (fail&&image.src.endsWith(fail)?image.onerror:image.onload)();
    await scope.module.exports.ready;
  }};
}
const draw = (api, method, ...args) => { const cv=canvas(100,100); ok(api[method](cv.getContext('2d'),...args),method+' accepts loaded authored art'); return cv.draws.at(-1); };
async function main() {
  const classic=load({classic:true}); await classic.finish();
  equal(classic.requests.length,0,'classic mode never requests replacement images');
  equal(classic.api.enabled(),false,'classic mode leaves native drawing in charge');
  const pending=load(), empty=canvas(16,16);
  equal(pending.api.floor(empty.getContext('2d'),0,0,12,0,0),false,'pending assets retain native floor fallback');
  equal(empty.draws.length,0,'pending floor paints no incomplete replacement');
  await pending.finish(); const api=pending.api;
  ok(api.enabled()&&api.isRemaster(),'complete asset set enables the remaster');
  equal(pending.dataset.textureRevision,'bridge-remaster','loaded pack exposes its actual revision');
  const floorPaths=new Set(),wallPaths=new Set();
  for(const id of Surface.MATERIALS) {
    const d=draw(api,'floor',0,0,12,0,0,id);
    const paths=[...d.image.paths]; equal(paths.length,1,id+' floor samples one authored source');
    ok(paths[0].endsWith('/remaster/floors/'+id+'.png'),id+' selection loads its own floor art'); floorPaths.add(paths[0]);
  }
  for(const id of Surface.WALLS) {
    const d=draw(api,'wall',0,0,12,39,0,id);
    const paths=[...d.image.paths]; equal(paths.length,1,id+' wall samples one authored source');
    ok(paths[0].endsWith('/remaster/walls/'+id+'.png'),id+' selection loads its own wall art'); wallPaths.add(paths[0]);
  }
  equal(floorPaths.size,Surface.MATERIALS.length,'no floor selection silently shares a fallback image');
  equal(wallPaths.size,Surface.WALLS.length,'no wall selection silently shares a fallback image');
  const failure=load({fail:'/remaster/floors/hex.png'}); await failure.finish();
  equal(failure.api.enabled(),false,'one failed asset prevents a mixed old/new station');
  equal(failure.dataset.textureRevision,'native','failed pack reports native fallback');
  const noPaint=canvas(100,100), c=noPaint.getContext('2d');
  for(const [method,args] of [['floor',[0,0,12,0,0]],['wall',[0,0,12,39,0]],['shell',[12,12,0,0]],['shellPlate',[0,0,12,12]],['workstation',[0,0,36,12]],['chair',[0,0,12,12]],['furniture',['console-bank',0,0,36,12]]])
    equal(failure.api[method](c,...args),false,method+' declines after any asset failure');
  equal(failure.api.wallStrip(39),null,'failed pack supplies no partial corner strip');
  equal(failure.api.workstationEmitter(0,0,36,12),null,'failed art invents no workstation source');
  equal(noPaint.draws.length,0,'failed pack leaves every native surface untouched');
  for (const url of pending.requests) {
    const broken=load({fail:url}); await broken.finish();
    equal(broken.api.enabled(),false,'failure of '+url+' keeps the complete station native');
    equal(broken.api.status().failed.length,1,'individual asset failure remains visible in loader status');
  }
  equal(api.floor(c,0,0,12,0,0,'hex','#555555',{detail:0}),false,'flat floor control declines textured art');
  equal(api.wall(c,0,0,12,39,0,'ribbed','#555555',{detail:0}),false,'flat wall control declines textured art');
  equal(api.wallStrip(39,'ribbed','#555555',{detail:0}),null,'flat corners use the same native fallback');
  const neg=draw(api,'floor',0,0,12,-1,-1,'alloy'), period=neg.image.width/neg.sw;
  equal([neg.sx,neg.sy],[neg.image.width-neg.sw,neg.image.height-neg.sh],'negative floor coordinates wrap inside the image');
  const repeat=draw(api,'floor',0,0,12,period-1,period-1,'alloy');
  equal([repeat.sx,repeat.sy,repeat.sw,repeat.sh],[neg.sx,neg.sy,neg.sw,neg.sh],'signed floor addresses repeat without a seam');
  const nearWall=draw(api,'wall',0,0,12,39,-1,'service','#556677');
  equal(nearWall.sx,nearWall.image.width-nearWall.sw,'negative wall coordinate wraps to the preceding bay');
  const bays=nearWall.image.width/nearWall.sw, north=canvas(bays*12,39);
  for(let x=0;x<bays;x++) api.wall(north.getContext('2d'),x*12,0,12,39,x,'service','#556677');
  const strip=api.wallStrip(39,'service','#556677');
  equal([strip.w,strip.h],[north.width,north.height],'corner strip spans exactly one north-wall bay period');
  equal(Buffer.from(strip.d),Buffer.from(north.pixels),'straight wall and corner strip contain the same material pixels and phase');
  ok(api.wallStrip(39,'service','#556677')===strip,'identical material and paint reuses its strip');
  ok(api.wallStrip(39,'ribbed','#556677')!==strip,'a different wall material cannot reuse another strip');
  ok(api.wallStrip(39,'service','#775544')!==strip,'a different selected paint cannot reuse another strip');
  ok(api.wallStrip(30,'service','#556677')!==strip,'different wall height has a correctly sized strip');

  const wallPatchPixels = alongOffset => {
    const base=canvas(12,5), detail=api.detailContext(base.getContext('2d'));
    api.wallPatch(detail,0,0,12,5,strip,(x,y)=>({a:x+alongOffset,d:y+.5}));
    const output=canvas(12,5);
    ok(api.drawBase(output.getContext('2d'),base),'wall patch exposes its denser artwork through the normal draw path');
    const dense=output.draws.at(-1).image;
    return {width:dense.width,height:dense.height,pixels:Buffer.from(dense.pixels)};
  };
  equal(wallPatchPixels(-strip.w),wallPatchPixels(0),'side/corner high-detail sampling wraps the same wall strip phase at negative coordinates');

  const black=draw(api,'floor',0,0,12,0,0,'plate','#111111'), gray=draw(api,'floor',0,0,12,0,0,'plate','#888888');
  ok(black.image!==gray.image,'neutral paint selections have distinct cached materials');
  const neutralPaintResponds=Buffer.compare(Buffer.from(black.image.pixels),Buffer.from(gray.image.pixels))!==0;
  for(const [w,h,facing,asset] of [[36,12,'s','/workstation.png'],[24,12,'s','/workstation-compact.png'],[36,12,'n','/remaster/workstation-n.png'],[24,12,'n','/remaster/workstation-compact-n.png'],[12,24,'e','/remaster/workstation-e.png'],[12,36,'e','/remaster/workstation-e.png']]) {
    const d=draw(api,'workstation',20,30,w,h,facing);
    ok([...d.image.paths].some(p=>p.endsWith(asset)),w+'x'+h+' '+facing+' picks the correct authored desk view');
    near(d.dw/d.dh,d.image.width/d.image.height,'desk image retains its source aspect ratio');
    near(d.dy+d.dh,30+h,'desk sits on the exact footprint floor line');
    near(d.dx+d.dw/2,20+w/2,'desk is centered on its actual footprint');
    ok(d.dh<=h+12&&d.dw>0&&d.dh>0,'monitor height remains bounded above the real footprint');
    const emitter=api.workstationEmitter(20,30,w,h,facing);
    if(facing==='n') equal(emitter,null,'north cabinet has no invented front screen emitter');
    else {
      const raw=pending.assets.get([...d.image.paths][0]), [a,b]=raw.points;
      const cx=((a.x+.5)+2*(b.x+.5))/3, cy=((a.y+.5)+2*(b.y+.5))/3;
      near(emitter.x,d.dx+cx/raw.width*d.dw,'source x follows the cyan-weighted screen centroid');
      near(emitter.y,d.dy+cy/raw.height*d.dh,'source y follows the cyan-weighted screen centroid');
      const reads=d.image.reads, moved=api.workstationEmitter(33,23,w,h,facing);
      near(moved.x,emitter.x+13,'moving the footprint translates the same screen source x');
      near(moved.y,emitter.y-7,'moving the footprint translates the same screen source y');
      equal(d.image.reads,reads,'screen centroid is cached instead of rereading all sprite pixels every frame');
    }
  }
  const unlit=load({darkScreens:true}); await unlit.finish();
  equal(unlit.api.workstationEmitter(0,0,36,12),null,'noncyan and dark artwork invents no screen emitter');
  ok(neutralPaintResponds,'neutral paint changes the authored material luminance');
  equal(api.crate(canvas().getContext('2d'),0,0,24,12),true,'normal station uses the user-approved crate');
  const review=load({review:true});
  equal(review.api.crate(canvas().getContext('2d'),0,0,24,12),false,'pending review art retains native fallback');
  await review.finish();
  equal(review.dataset.propReview,'crate','loaded one-prop review is inspectable');
  const cargo=draw(review.api,'crate',20,30,24,12);
  ok([...cargo.image.paths].some(p=>p.endsWith('/calibration/crate.png')),'review uses the generated crate');
  near(cargo.dw/cargo.dh,cargo.image.width/cargo.image.height,'crate keeps source aspect without squashing');
  near(cargo.dx+cargo.dw/2,32,'crate remains centered on its original footprint');
  near(cargo.dy+cargo.dh,42,'crate skids end at the original ground line');
  ok(cargo.dw<=26&&cargo.dh<=22,'crate stays inside the original body envelope');
  const classicReview=load({classic:true,review:true});await classicReview.finish();
  equal(classicReview.api.crate(canvas().getContext('2d'),0,0,24,12),false,'classic never adopts review art');
  const failedReview=load({review:true,fail:'calibration/crate.png'});await failedReview.finish();
  equal(failedReview.api.crate(canvas().getContext('2d'),0,0,24,12),false,'failed review retains complete fallback');
  for(const id of ['viewport','wainscot','hedge']) {
    ok(api.supportsWall(id),'specialized wall has authored coverage: '+id);
    const d=draw(api,'wall',0,0,12,33,0,id);
    ok([...d.image.paths].some(p=>p.endsWith('/walls/'+id+'.png')),id+' uses its own artwork instead of bulkhead fallback');
    ok(api.wallStrip(33,id).hi,'specialized side/corner strip retains high resolution: '+id);
  }
  const windowPlate=canvas(40,45);
  ok(api.viewportFrame(windowPlate.getContext('2d'),4,4,24,33),'authored window frame draws');
  for(let y=7;y<31;y++)for(let x=5;x<27;x++)assert.equal(windowPlate.pixels[(y*40+x)*4+3],0,'frame must leave live sky transparent');
  checks++;
  const cap=canvas(120,8);api.crown(cap.getContext('2d'),0,0,120,4,-6,false);
  ok(cap.paths.has('assets/industrial/remaster/crown.png'),'ridge uses authored coping texture');
  equal(cap.draws.reduce((n,d)=>n+d.dw,0),120,'crown wraps negative world phase without dropping length');
  equal(classic.api.supportsWall('viewport'),false,'classic keeps specialized fallback geometry');
  console.log('industrialtextures: OK ('+checks+' public-contract assertions; synthetic canvas assets, live artwork not assessed)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
