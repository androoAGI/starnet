'use strict';
// Build-time alpha measurement avoids synchronous full-resolution GPU readback
// of every source PNG during page startup. Source pixels are not rewritten.
const fs=require('node:fs'),crypto=require('node:crypto'),sharp=require('sharp');
const root='frontend/assets/industrial/projection-correction/';
(async()=>{
 const manifest=JSON.parse(fs.readFileSync(root+'manifest.json')),views={};
 for(const [id,p]of Object.entries(manifest.props))for(const [face,v]of Object.entries(p.views)){
  const bytes=fs.readFileSync(root+v.image),{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let l=info.width,t=info.height,r=-1,b=-1;
  for(let i=3;i<data.length;i+=4)if(data[i]){const n=(i-3)/4,x=n%info.width,y=Math.floor(n/info.width);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
  if(r<l)throw Error('Empty '+id+':'+face);
  views[id+':'+face]={image:v.image,width:info.width,height:info.height,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),crop:{x:l,y:t,width:r-l+1,height:b-t+1}};
 }
 fs.writeFileSync(root+'runtime-geometry.json',JSON.stringify({version:1,views},null,2));
 console.log('Measured '+Object.keys(views).length+' alpha bounds; source PNGs unchanged.');
})().catch(e=>{console.error(e);process.exitCode=1;});
