'use strict';
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const dir='docs/station-remaster/catalog-floor',out='frontend/assets/industrial/catalog-floor',source=dir+'/sheet-source.png';
const structure=JSON.parse(fs.readFileSync('dev/industrial-textures/prop-structure-manifest.json'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const items=[['airlock',170,65,255,255],['arc_floorlight',665,75,220,225],['cablerun',40,400,510,160],['hazardpad',570,350,445,220],['industrial_cabletray',40,640,510,145],['industrial_floorvent',570,600,445,220],['rug',100,830,395,270],['rug_small',650,830,285,275],['rug_large',130,1105,335,315],['bridge_deckperimeter',565,1110,450,310]];
(async()=>{
 const records=[];
 for(let [id,left,top,width,height]of items){
  const selected=['cablerun','industrial_cabletray'].includes(id)?dir+'/cables-source.png':source;
  if(id==='cablerun'){left=10;top=360;width=1180;height=310;}if(id==='industrial_cabletray'){left=10;top=825;width=1180;height=260;}
  const bytes=fs.readFileSync(selected),s=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const raw=Buffer.alloc(width*height*4),core=new Uint8Array(width*height);let contactBottom=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const d=(y*width+x)*4,q=((y+top)*s.info.width+x+left)*4;s.data.copy(raw,d,q,q+4);if(raw[d+3]>=180){core[y*width+x]=1;contactBottom=Math.max(contactBottom,y);}}
  let l=width,t=height,r=-1,b=-1,retained=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const d=(y*width+x)*4;let keep=!!core[y*width+x];if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-3);yy<=Math.min(height-1,y+3)&&!keep;yy++)for(let xx=Math.max(0,x-3);xx<=Math.min(width-1,x+3);xx++)if(core[yy*width+xx]&&(x-xx)**2+(y-yy)**2<=9){keep=true;break;}if(!keep){raw[d+3]=0;continue;}retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
  if(r<l)throw Error('Empty '+id);
  const sw=r-l+1,sh=b-t+1,png=await sharp(raw,{raw:{width,height,channels:4}}).extract({left:l,top:t,width:sw,height:sh}).png().toBuffer(),image=id+'.png';fs.writeFileSync(out+'/'+image,png);
  const v=structure.props[id].views.s,bounds=v.bounds,fit=Math.min(bounds.width/sw,bounds.height/sh),contact={x:.5,y:(contactBottom+1-t)/sh};
  records.push({id,view:'s',image,repoPath:out+'/'+image,sourceWidth:sw,sourceHeight:sh,footprint:v.footprint,bounds,contact,actualFit:{width:sw*fit,height:sh*fit},source:selected,sourceSha256:hash(bytes),outputSha256:hash(png),sourceCrop:{left:left+l,top:top+t,width:sw,height:sh},retained,status:'candidate; retained source RGBA, native floor footprint, uniform fit'});
 }
 fs.writeFileSync(dir+'/integration.json',JSON.stringify({version:1,records},null,2)+'\n');console.log(records.map(r=>({id:r.id,source:[r.sourceWidth,r.sourceHeight],fit:r.actualFit})));
})().catch(e=>{console.error(e);process.exitCode=1;});
