'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto'),sharp=require('sharp');
const root='frontend/assets/industrial/projection-correction/',manifest=require('../'+root+'manifest.json'),geometry=require('../'+root+'runtime-geometry.json');
(async()=>{
 let count=0;
 for(const [id,p]of Object.entries(manifest.props))for(const [face,v]of Object.entries(p.views)){
  const entry=geometry.views[id+':'+face],bytes=fs.readFileSync(root+v.image);
  assert.equal(entry.image,v.image);assert.equal(entry.width,v.sourceWidth);assert.equal(entry.height,v.sourceHeight);
  assert.equal(entry.sha256,crypto.createHash('sha256').update(bytes).digest('hex'),'Rebuild geometry after changing '+v.image);
  const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let l=info.width,t=info.height,r=-1,b=-1;
  for(let i=3;i<data.length;i+=4)if(data[i]){const n=(i-3)/4,x=n%info.width,y=Math.floor(n/info.width);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
  assert.deepEqual(entry.crop,{x:l,y:t,width:r-l+1,height:b-t+1});count++;
  const sourceDensity=Math.max(entry.crop.width/v.bounds.width,entry.crop.height/v.bounds.height);
  assert(sourceDensity>=6,id+':'+face+' source must support the 6x camera without upscaling');
 }
 assert.equal(Object.keys(geometry.views).length,count);
 console.log('PASS: '+count+' runtime alpha crops match source hashes and every nontransparent pixel.');
})().catch(e=>{console.error(e);process.exitCode=1;});
