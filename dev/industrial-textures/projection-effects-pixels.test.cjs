'use strict';
// Real canvas pixel regression and review raster. QA only; no production PNG edits.
const assert=require('node:assert/strict'),fs=require('node:fs');
let Canvas;try{Canvas=require('@napi-rs/canvas');}catch{Canvas=require('C:/Users/andro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas');}
const fx=require('../../frontend/app/projection-prop-effects.js'),manifest=require('../../frontend/assets/industrial/projection-correction/manifest.json');
global.OffscreenCanvas=class{constructor(w,h){return Canvas.createCanvas(w,h);}};
const dir='docs/station-remaster/projection-effects';
const active={now:2100,work:true,occupied:true,scanning:true,live:true,bound:true,state:'online',fired:.75,bad:false,pins:3,trophies:2,crates:2,door:'open'};
const inactive={now:2100,work:false,occupied:false,scanning:false,live:false,bound:false,state:'offline',fired:0,pins:0,trophies:0,crates:0,door:'closed'};
(async()=>{
 const receipts=[],images=new Map();
 for(const id of fx.ids){
  const v=manifest.props[id].views.s,im=await Canvas.loadImage('frontend/assets/industrial/projection-correction/'+v.image),p=fx.prepare(id,'s',im,v);
  const sw=v.sourceWidth,sh=v.sourceHeight,scale=Math.min(1,220/Math.max(sw,sh)),w=sw*scale,h=sh*scale;
  const box={x:110,y:150,width:w,height:h,crop:{x:0,y:0,width:sw,height:sh},sourceWidth:sw,sourceHeight:sh};
  function paint(state){const c=Canvas.createCanvas(460,440),g=c.getContext('2d');g.drawImage(im,box.x,box.y,w,h);if(state)fx.draw(g,id,'s',box,state,p);return c;}
  const base=paint(),off=paint(inactive),on=paint(active),frozenA=paint({...active,now:50,still:true}),frozenB=paint({...active,now:17000,still:true});
  assert.deepEqual(frozenA.toBuffer('image/png'),frozenB.toBuffer('image/png'),id+' freeze pixels');
  const a=base.getContext('2d').getImageData(0,0,460,440).data,b=on.getContext('2d').getImageData(0,0,460,440).data;
  // The union of authored regions is independent of renderer implementation.
  // Rasterize its mask with a 2px edge tolerance for antialiasing. Any changed
  // pixel outside it is an accidental full-body wash or a coordinate conversion bug.
  const mask=Canvas.createCanvas(460,440),mg=mask.getContext('2d');mg.fillStyle='#fff';mg.strokeStyle='#fff';mg.lineWidth=3;
  for(const e of fx.classify(id).effects){
   if(e.kind==='hologram'){const r=fx.frameBounds(id);mg.fillRect(box.x+r.x*w-2,box.y+r.y*h-2,r.width*w+4,r.height*h+4);continue;}
   mg.beginPath();e.region.forEach((q,i)=>i?mg.lineTo(box.x+q[0]*w,box.y+q[1]*h):mg.moveTo(box.x+q[0]*w,box.y+q[1]*h));mg.closePath();mg.fill();mg.stroke();
  }
  const maskData=mg.getImageData(0,0,460,440).data;let changed=0,escaped=0,outsideBody=0;
  for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3]){changed++;if(!maskData[i+3])escaped++;if(a[i+3]===0&&b[i+3]>8)outsideBody++;}
  assert.equal(escaped,0,id+' cannot affect pixels outside authored regions');
  const stateChanges=!off.toBuffer('image/png').equals(on.toBuffer('image/png'));
  if(fx.classify(id).effects.some(e=>!['ambient'].includes(e.gate)))assert(stateChanges,id+' real state changes visible pixels');
  if(!['steamvent','coffee','treasury_pnl_holo'].includes(id))assert.equal(outsideBody,0,id+' cannot paint solid effects beside the source silhouette');
  receipts.push({id,changedPixels:changed,escapedPixels:escaped,outsideSourceAlpha:outsideBody,activeIdleDifferent:stateChanges,stillDeterministic:true});
  images.set(id,{im,off,on,v});fx.dispose(p);
 }
 // Actual world scale rather than normalizing all objects to equal size.
 const selected=['filter','workbench','intake','bay','screens','studio','comms_uplink','war_intelcab','bridge_relaystack','jukebox','arcade','pinball','coffee','steamvent','fishtank','lavalamp','plasmaglobe','incubator','connector_portal','airlock','missionboard','trophycase','pub_publishpress','treasury_pnl_holo'];
 const proof=Canvas.createCanvas(1200,1200),g=proof.getContext('2d');g.fillStyle='#303638';g.fillRect(0,0,1200,1200);g.font='12px sans-serif';
 for(let i=0;i<selected.length;i++){
  const id=selected[i],{im,v}=images.get(id),x=i%4*300,y=Math.floor(i/4)*200,s=Math.min(v.bounds.width/v.sourceWidth,v.bounds.height/v.sourceHeight),w=v.sourceWidth*s*3,h=v.sourceHeight*s*3,p=fx.prepare(id,'s',im,v);
  g.fillStyle='#dce0d9';g.fillText(id+'  idle | active 3x',x+8,y+16);
  for(const[j,state]of [inactive,active].entries()){const box={x:x+25+j*140,y:y+180-h,width:w,height:h,crop:{x:0,y:0,width:v.sourceWidth,height:v.sourceHeight},sourceWidth:v.sourceWidth,sourceHeight:v.sourceHeight};g.drawImage(im,box.x,box.y,w,h);fx.draw(g,id,'s',box,state,p);}
  fx.dispose(p);
 }
 fs.writeFileSync(dir+'/state-pixels.png',proof.toBuffer('image/png'));fs.writeFileSync(dir+'/pixel-checks.json',JSON.stringify({version:1,renderer:'@napi-rs/canvas (offline QA, not live app)',effects:receipts.length,checks:receipts},null,2)+'\n');
 console.log('PASS '+receipts.length+' real canvas overlays: no changed pixels outside regions, active/idle gates, deterministic still. Native-scale proof generated.');
})().catch(e=>{console.error(e);process.exitCode=1;});
