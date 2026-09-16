'use strict';
// Offline source-render proof, not a browser or live saved-station claim.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const Mounts=require('../../frontend/app/authored-surface-mounts.js');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p);
const context=vm.createContext({});vm.runInContext(fs.readFileSync(at('frontend/app/authored-surface-calibration.js'),'utf8')+'\nthis.data=AuthoredSurfaceCalibration;',context);
const calibration=JSON.parse(JSON.stringify(context.data));
const manifest=JSON.parse(fs.readFileSync(at('frontend/assets/industrial/props-v3/manifest.json')));
const objects=new Map();
const fit=(b,c)=>{const s=Math.min(b.width/c.width,b.height/c.height);return{x:b.x+(b.width-c.width*s)/2,y:b.y+b.height-c.height*s,width:c.width*s,height:c.height*s};};
async function prepare(key,file,spec,bounds){
 const image=await loadImage(at(file)),canvas=createCanvas(image.width,image.height),g=canvas.getContext('2d');g.drawImage(image,0,0);const data=g.getImageData(0,0,image.width,image.height).data;
 let l=image.width,t=image.height,r=-1,b=-1;for(let i=3;i<data.length;i+=4)if(data[i]){const p=(i-3)/4,x=p%image.width,y=Math.floor(p/image.width);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
 const crop={x:l,y:t,width:r-l+1,height:b-t+1};objects.set(key,{image,spec,crop,box:fit(bounds,crop)});
}
(async()=>{
 const cases=[['lowtable','e',0],['glasstable','e',0],['longtable','e',1],['glasstable','s',0]],jobs=[];
 for(const[id,v]of cases){const s=calibration.props[id].views[v];jobs.push(prepare(id+':'+v,s.art,{image:s.image,sourceWidth:s.sourceWidth,sourceHeight:s.sourceHeight,footprint:s.footprint},s.bounds));}
 jobs.push(prepare('mug:s','frontend/assets/industrial/batch03/storage/mug.png',{image:'mug.png',sourceWidth:1050,sourceHeight:1027,footprint:{w:1,h:1}},{x:4,y:8,width:4,height:4}));
 const caddy=manifest.props.industrial_toolcaddy.views.s;jobs.push(prepare('industrial_toolcaddy:s','frontend/assets/industrial/props-v3/'+caddy.image,caddy,caddy.bounds));
 await Promise.all(jobs);
 const engine=Mounts.create({calibration,viewGeometry:(t,v)=>objects.get(t+':'+v),ruleFor:t=>({surface:!!calibration.props[t]})});
 const canvas=createCanvas(1000,1360),g=canvas.getContext('2d');g.fillStyle='#0b1113';g.fillRect(0,0,1000,1360);g.font='22px monospace';g.fillStyle='#dcd4b6';g.fillText('Actual new table art + unchanged child footprints',24,33);g.font='13px monospace';g.fillStyle='#a9bcb2';g.fillText('Offline render fixture — left: fixed 8 px lift / right: authored tabletop support',24,57);
 const receipts=[];
 function draw(p,lift){const o=objects.get(p.t+':'+(p.r===3?'e':'s'));g.save();g.translate(p.x*12,p.y*12-lift);if(p.m){g.translate(p.w*12,0);g.scale(-1,1);}g.drawImage(o.image,o.crop.x,o.crop.y,o.crop.width,o.crop.height,o.box.x,o.box.y,o.box.width,o.box.height);g.restore();}
 cases.forEach(([id,view,m],index)=>{
  const spec=calibration.props[id].views[view],host={id:'host',t:id,x:0,y:0,w:spec.footprint.w,h:spec.footprint.h,r:view==='e'?3:0,m};
  const children=[];for(let y=0;y<host.h;y++)for(let x=0;x<host.w;x++)children.push({id:`child-${x}-${y}`,t:x===host.w-1&&host.h===1?'industrial_toolcaddy':'mug',x,y,w:1,h:1});engine.setLayout([host,...children]);
  const placements=children.map(p=>({child:p,...engine.placementFor(p)}));receipts.push({id,view,mirror:m,placements});
  for(let side=0;side<2;side++){
   const ox=side*500+24,oy=index*318+78;g.fillStyle='#152122';g.fillRect(ox,oy,472,301);g.fillStyle='#c8c095';g.font='15px monospace';g.fillText(`${id} ${view}${m?' mirrored':''} / ${side?'authored':'legacy'}`,ox+14,oy+22);
   g.save();g.translate(ox+150,oy+42);g.scale(6,6);g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';draw(host,0);
   for(const p of placements)draw(p.child,side?p.lift:8);g.restore();
   g.font='11px monospace';g.fillStyle='#a9c1ae';g.fillText(placements.map(p=>side?p.lift.toFixed(2):'8.00').join(' / ')+' px lift, far → near',ox+14,oy+285);
  }
 });
 const dir=at('docs/station-remaster/surface-mounts');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'native-placement.png'),canvas.toBuffer('image/png'));fs.writeFileSync(path.join(dir,'render-receipt.json'),JSON.stringify({scope:'Offline actual-source composite, no live-station acceptance',cases:receipts},null,2)+'\n');
 console.log(JSON.stringify({proof:'docs/station-remaster/surface-mounts/native-placement.png',cases:receipts.length,placements:receipts.reduce((n,p)=>n+p.placements.length,0),allAuthored:receipts.every(p=>p.placements.every(v=>v.authored))}));
})().catch(e=>{console.error(e);process.exitCode=1;});
