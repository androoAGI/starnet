'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let Canvas;try{Canvas=require('@napi-rs/canvas');}catch{Canvas=require('C:/Users/andro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas');}
const makeCanvas=()=>Canvas.createCanvas(1,1);
async function materials(){
  const allocated=[];
  class Image {constructor(){const c=Canvas.createCanvas(12,12);c.getContext('2d').fillRect(0,0,12,12);Object.defineProperty(c,'src',{set(){queueMicrotask(()=>c.onload());}});return c;}}
  const scope={module:{exports:{}},URLSearchParams,location:{search:'?propSet=projection'},Image,document:{documentElement:{dataset:{}},createElement(){const c=makeCanvas();allocated.push(c);return c;}}};
  vm.runInNewContext(fs.readFileSync('frontend/app/industrialtextures.js','utf8'),scope);
  const api=scope.module.exports;await api.ready;return {api,allocated};
}
(async()=>{
  const {api,allocated}=await materials(),base=Canvas.createCanvas(64,64);let g=api.detailContext(base.getContext('2d'));
  // Subpixel alternating bars expose aliasing; large planes must retain alpha.
  for(let x=8;x<56;x++){g.fillStyle=x%2?'#c0c0c0':'#404040';g.fillRect(x,8,1,48);}
  const target=Canvas.createCanvas(400,400),ctx=target.getContext('2d'),native=ctx.drawImage.bind(ctx);let source;
  ctx.drawImage=(im,...args)=>{source=im;return native(im,...args);};
  ctx.setTransform(1,0,0,1,0,0);assert(api.drawBase(ctx,base));assert.equal(source.width,48,'distant architecture uses a coarser 0.75x plate while props remain independent');
  const first=source;api.drawBase(ctx,base);assert.equal(source,first,'stationary frames reuse the plate');
  const px=ctx.getImageData(0,0,64,64).data;assert.equal(px[3],0,'empty space stays transparent');assert.equal(px[(32*64+32)*4+3],255,'interior remains opaque');
  ctx.setTransform(6,0,0,6,0,0);api.drawBase(ctx,base);assert.equal(source.width,384,'close view retains the full authored detail');
  g.fillStyle='#ff0000';g.fillRect(0,0,64,64);ctx.setTransform(1,0,0,1,0,0);api.drawBase(ctx,base);assert.notEqual(source,first,'rebaked pixels invalidate cached reductions');
  const center=ctx.getImageData(32,32,1,1).data;assert(center[0]>240&&center[1]<5,'new pixels survive pyramid rebuild');

  // Execute the real world watchdog against real canvas pixels. Losing only a
  // remaster plate used to evade it because the native bake remained opaque.
  const world=fs.readFileSync('frontend/app/world.js','utf8');
  const watchdog=world.slice(world.indexOf('  let bakeProbe = null;'),world.indexOf('  /* ---------- STAGE CONTEXT LOSS'));
  let rebuilt=0;
  const lossScope={document:{createElement:makeCanvas},IndustrialTextures:api,cache:{baseCv:base},bakeDirty:false,console:{warn(){}},
    rebake(){rebuilt++;g.fillStyle='#ff0000';g.fillRect(0,0,64,64);lossScope.recordBakeProbe();}};
  vm.runInNewContext(watchdog+'\nthis.recordBakeProbe=recordBakeProbe;this.blank=bakeWentBlank;this.watch=watchCanvasLoss;',lossScope);
  lossScope.recordBakeProbe();assert.equal(lossScope.blank(),false);
  const levels=api.baseLayers(base);assert(levels.length>1,'zoom reductions exist');
  const low=levels.at(-1);low.getContext('2d').clearRect(0,0,low.width,low.height);
  assert.equal(base.getContext('2d').getImageData(32,32,1,1).data[3],255,'native bake survives: old watchdog missed this');
  assert.equal(lossScope.blank(),true,'blank overview plate detected independently');
  lossScope.watch(1000);assert.equal(rebuilt,0,'LOD loss does not rebuild entire station');assert.equal(lossScope.blank(),false,'recovery replaces damaged zoom chain');
  ctx.clearRect(0,0,400,400);api.drawBase(ctx,base);assert(ctx.getImageData(32,32,1,1).data[3]>0,'recovered station actually renders');
  for(let i=0;i<3;i++){
    // Restore a fresh detail plate as a normal rebake would.
    g=api.detailContext(base.getContext('2d'));g.fillRect(0,0,64,64);lossScope.recordBakeProbe();
    const hi=api.baseLayers(base)[0];hi.getContext('2d').clearRect(0,0,hi.width,hi.height);
    assert.equal(lossScope.blank(),true,'high resolution loss detected');lossScope.watch(1300+i*300);
    assert.equal(lossScope.blank(),false,'repeated losses heal without a success cooldown');
    assert.equal(api.drawBase(ctx,base),false,'lost high detail falls back to intact native bake');
    ctx.clearRect(0,0,400,400);ctx.drawImage(base,0,0);
    assert.equal(ctx.getImageData(32,32,1,1).data[3],255,'native fallback visibly preserves the station');
  }
  assert.equal(rebuilt,0,'detail loss never forces a full station rebake');
  g=api.detailContext(base.getContext('2d'));g.fillRect(0,0,64,64);lossScope.recordBakeProbe();
  base.getContext('2d').clearRect(0,0,64,64);lossScope.watch(2400);
  assert.equal(rebuilt,1,'native bake loss still invokes full recovery');
  // Returned lists cannot mutate cache ownership, and absent/empty plates are safe.
  api.baseLayers(base).length=0;assert(api.baseLayers(base).length>0);
  lossScope.cache.baseCv=Canvas.createCanvas(64,64);api.detailContext(lossScope.cache.baseCv.getContext('2d'));
  lossScope.recordBakeProbe();assert.equal(lossScope.blank(),false,'legitimately empty station does not loop');
  const tile=Canvas.createCanvas(12,12),tg=tile.getContext('2d');
  api.floor(tg,0,0,12,0,0,'plate');assert.equal(tg.getImageData(6,6,1,1).data[3],255);
  for(const c of allocated)c.getContext('2d').clearRect(0,0,c.width,c.height);
  tg.clearRect(0,0,12,12);api.floor(tg,0,0,12,0,0,'plate');
  assert.equal(tg.getImageData(6,6,1,1).data[3],0,'lost material caches would paint an empty rebake');
  api.restoreMaterials();api.floor(tg,0,0,12,0,0,'plate');
  assert.equal(tg.getImageData(6,6,1,1).data[3],255,'original image restores material and derived tint caches');

  const props=fs.readFileSync('frontend/app/propsprites.js','utf8'),start=props.indexOf('  function contactShadow('),end=props.indexOf('  function projectedShadow(',start);
  assert(start>0&&end>start);
  const scope={document:{createElement:makeCanvas},contactShadows:new WeakMap()};
  vm.runInNewContext(props.slice(start,end)+'\nthis.contact=contactShadow;',scope);
  const mask=Canvas.createCanvas(60,80),m=mask.getContext('2d');m.fillStyle='#000';
  m.fillRect(18,45,24,2); // elevated tabletop must not produce a solid contact slab
  m.fillRect(18,47,2,13);m.fillRect(40,47,2,13);
  const contact=scope.contact(mask,12),a=contact.getContext('2d').getImageData(0,0,contact.width,7).data;
  const alpha=x=>a[(3*contact.width+x)*4+3];
  assert(alpha(20)>200&&alpha(42)>200,'actual feet have contact');assert.equal(alpha(31),0,'open space between legs stays open');
  assert.equal(scope.contact(mask,12),contact,'contact extraction is cached');
  const air=Canvas.createCanvas(60,80);air.getContext('2d').fillRect(16,20,30,20);
  const noContact=scope.contact(air,12).getContext('2d').getImageData(0,0,64,7).data;
  assert(!noContact.some((v,i)=>i%4===3&&v),'raised artwork without feet cannot create floor contact');
  console.log('PASS: overview filtering, close detail, stable alpha, cache invalidation, silhouette foot contact and open leg gaps.');
})().catch(e=>{console.error(e);process.exitCode=1;});
