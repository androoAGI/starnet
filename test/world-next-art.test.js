'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const A=require('./_assert.js');
const Art=require('../frontend/world-next/art.js');
const dir=path.resolve(__dirname,'../frontend/world-next/assets/props');
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8').replace(/^\uFEFF/,''));

// Catalog comparison reads only the old module's declarative IDs. No legacy
// art code is evaluated by the new client or by this coverage assertion.
const oldSource=fs.readFileSync(path.resolve(__dirname,'../frontend/app/propsprites.js'),'utf8');
const oldIds=[...oldSource.slice(oldSource.indexOf('const CATALOG =')).matchAll(/\{ id: "([^"]+)", label: "[^"]+"/g)].map(m=>m[1]);
for(const id of oldIds)A.ok(!Art.getSpec(id).placeholder,id+' retains an explicit new-art family');
A.eq(Art.TILE,32,'new art uses the independent 32px world grid');
A.eq(Art.MASTERS.length,20,'twenty genuinely new bitmap masters');
A.eq(manifest.legacyArtReused,false,'provenance explicitly records no reused old artwork');
A.ok(manifest.generationCount<=30,'recorded PixelLab generations stay within assigned budget');
const hashes=new Set();
for(const asset of manifest.assets){
  const file=path.join(dir,asset.file),bytes=fs.readFileSync(file);
  A.eq(bytes.slice(0,8).toString('hex'),'89504e470d0a1a0a',asset.name+' is a real PNG');
  A.eq(bytes.readUInt32BE(16),asset.width,asset.name+' width matches provenance');
  A.eq(bytes.readUInt32BE(20),asset.height,asset.name+' height matches provenance');
  A.eq(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.name+' has exact asset provenance');
  A.ok(!hashes.has(asset.sha256),asset.name+' is a distinct master image');hashes.add(asset.sha256);
  A.ok(asset.alphaPixels>500&&asset.transparentPixels>500,asset.name+' has visible art and transparent margins');
  const b=asset.bounds;A.ok(b.x>=0&&b.y>=0&&b.w>0&&b.h>0&&b.x+b.w<=asset.width&&b.y+b.h<=asset.height,asset.name+' alpha crop stays within the master');
  A.ok(asset.prompt&&asset.seed!=null&&/^[\da-f-]{36}$/.test(asset.jobId),asset.name+' retains prompt, seed and job ID');
}

function context(){
  const ops=[],stack=[];
  const g={ops,fillStyle:'',strokeStyle:'',globalAlpha:1,lineWidth:1,
    save(){stack.push([g.fillStyle,g.strokeStyle,g.globalAlpha,g.lineWidth]);ops.push(['save']);},
    restore(){[g.fillStyle,g.strokeStyle,g.globalAlpha,g.lineWidth]=stack.pop();ops.push(['restore']);},
    fillRect(...a){ops.push(['rect',...a,g.fillStyle,g.globalAlpha]);},
    strokeRect(...a){ops.push(['strokeRect',...a,g.strokeStyle,g.globalAlpha]);},
    beginPath(){ops.push(['begin']);},moveTo(...a){ops.push(['move',...a]);},lineTo(...a){ops.push(['line',...a]);},closePath(){ops.push(['close']);},
    ellipse(...a){ops.push(['ellipse',...a]);},fill(){ops.push(['fill',g.fillStyle,g.globalAlpha]);},stroke(){ops.push(['stroke',g.strokeStyle,g.lineWidth,g.globalAlpha]);},
    translate(...a){ops.push(['translate',...a]);},rotate(...a){ops.push(['rotate',...a]);},scale(...a){ops.push(['scale',...a]);},
    drawImage(im,...a){ops.push(['image',im.src,...a]);}
  };return g;
}
(async()=>{
  const art=await Art.create({manifest,baseUrl:'fresh/',loadImage:async src=>({src})});
  A.ok(art.ready,'asset loader reports complete fresh art');A.eq(art.masterCount,20,'loader resolves twenty master sprites');A.eq(art.failures,[],'successful loader has no hidden failures');
  const labels=new Set(),procedural=new Set();
  for(const spec of Art.catalog){
    const p={t:spec.type,x:-3,y:4,w:2,h:1},before=JSON.stringify(p),g=context();
    const box=art.drawProp(g,p,1000,{working:false,selected:true});
    A.eq(JSON.stringify(p),before,spec.type+' drawing never mutates placement data');
    A.eq(box.sortY,160,spec.type+' depth follows footprint bottom');
    A.eq(box.cx,-64,spec.type+' draw anchor is footprint center');
    A.ok(g.ops.length>8,spec.type+' has renderable authored art');
    A.ok(g.ops.every(op=>op.every(v=>typeof v!=='number'||Number.isFinite(v))),spec.type+' never emits nonfinite canvas coordinates');
    if(!spec.asset)procedural.add(spec.family);labels.add(spec.label);
  }
  A.ok(procedural.size>=15,'small props have numerous distinct original procedural shapes');
  A.eq(labels.size,Art.catalog.length,'type labels remain distinct for art inspection');
  const p={t:'desk',x:1,y:2,w:2,h:1};
  const stillA=context(),stillB=context();art.drawProp(stillA,p,0,{});art.drawProp(stillB,p,2000,{working:false});
  A.eq(stillA.ops,stillB.ops,'idle machines never invent time-dependent work');
  const fake=context();art.drawProp(fake,p,0,{working:'true'});A.eq(fake.ops,stillA.ops,'only explicit observed working=true can enable the work cue');
  const active=context();art.drawProp(active,p,80,{working:true});A.ok(JSON.stringify(active.ops)!==JSON.stringify(stillA.ops),'confirmed harness work has a visible activity cue');
  const turned=context();art.drawProp(turned,{...p,r:1},0,{});A.ok(turned.ops.some(o=>o[0]==='rotate'&&o[1]===Math.PI/2),'rotation is shown by the actual footprint direction marker');
  A.eq(Art.rotationOf({t:'telescope_r'}),1,'legacy fixed-direction IDs retain visible orientation');
  const mounted=art.getBounds({...p,t:'mug',host:'table-1'});A.eq(mounted.anchorY,80,'hosted tabletop object rises above the floor');
  const f=art.getBounds(p);A.eq(Math.round(f.y+f.h),96,'cropped sprite foot lands exactly on footprint bottom');
  const long=art.getBounds({...p,t:'bigscreen',w:8});A.eq(long.count,3,'large walls use repeated fresh displays without enormous stretched pixels');
  const failed=await Art.create({manifest,loadImage:async()=>{throw new Error('fixture failure');}});
  A.eq(failed.ready,false,'missing assets cannot report ready');A.eq(failed.failures.length,20,'every missing asset is reported');
  const fallback=context();A.notThrows(()=>failed.drawProp(fallback,p,0,{}),'fresh procedural fallback remains drawable when an image is unavailable');
  A.ok(!fallback.ops.some(o=>o[0]==='image'),'failure never falls back to old PNG artwork');
  const source=fs.readFileSync(path.resolve(__dirname,'../frontend/world-next/art.js'),'utf8');
  A.ok(!/PropSprites|Sprites\.|StationBake|app\/props|assets\/props\/v[0-9]/.test(source),'client art has no dependency on previous renderers or assets');
  A.report('world-next-art');
})().catch(e=>{A.ok(false,e.stack||e.message);A.report('world-next-art');});
