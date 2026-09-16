'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),sharp=require('sharp');
const docs='docs/station-remaster/catalog-crew-rest-2',out='frontend/assets/industrial/catalog-crew-rest-2';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const layout=JSON.parse(fs.readFileSync(docs+'/layout.json','utf8')),bytes=fs.readFileSync(layout.source);
 if(hash(bytes)!==layout.sourceSha256)throw Error('Source changed');
 const defaultSource=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 fs.mkdirSync(out,{recursive:true});const records=[];
 for(const cell of layout.cells){
  const sourcePath=cell.source||layout.source,sourceBytes=cell.source?fs.readFileSync(cell.source):bytes;
  if(cell.source&&hash(sourceBytes)!==cell.sourceSha256)throw Error('Override source changed '+cell.id);
  const {data,info}=cell.source?await sharp(sourceBytes).ensureAlpha().raw().toBuffer({resolveWithObject:true}):defaultSource;
  const {left,top,width:w,height:h}=cell.rect,raw=Buffer.alloc(w*h*4),core=new Uint8Array(w*h),radius=3;
  let maxAlpha=0,coreCount=0,edgeCore=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const src=((y+top)*info.width+x+left)*4,d=(y*w+x)*4;data.copy(raw,d,src,src+4);maxAlpha=Math.max(maxAlpha,raw[d+3]);
   if(raw[d+3]>=180){core[y*w+x]=1;coreCount++;if(!x||!y||x===w-1||y===h-1)edgeCore++;}
  }
  if(!coreCount||edgeCore)throw Error('Inspect source alpha/cell boundaries '+cell.id);
  let l=w,t=h,r=-1,b=-1,removed=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const d=(y*w+x)*4;if(!raw[d+3])continue;let keep=!!core[y*w+x];
   if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-radius);yy<=Math.min(h-1,y+radius)&&!keep;yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(w-1,x+radius);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=radius*radius){keep=true;break;}
   if(!keep){raw[d+3]=0;removed++;continue;}l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
  }
  const crop={left:l,top:t,width:r-l+1,height:b-t+1},image=out+'/'+cell.id+'.png';
  const png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toBuffer();fs.writeFileSync(image,png);
  const final=await sharp(png).ensureAlpha().raw().toBuffer();let rgbChanges=0,alphaChanges=0,zero=0,partial=0,opaque=0,lastCoreY=0;
  for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
   const dst=(y*crop.width+x)*4,src=((y+top+t)*info.width+x+left+l)*4,a=final[dst+3];
   if(!a){zero++;continue;}if(a===255)opaque++;else partial++;if(a>=180)lastCoreY=Math.max(lastCoreY,y);
   for(let c=0;c<3;c++)if(final[dst+c]!==data[src+c])rgbChanges++;if(a!==data[src+3])alphaChanges++;
  }
  if(rgbChanges||alphaChanges)throw Error('RGBA body changed '+cell.id);
  const bounds=cell.bounds,k=Math.min(bounds.width/crop.width,bounds.height/crop.height),fit={x:bounds.x+(bounds.width-crop.width*k)/2,y:bounds.y+bounds.height-crop.height*k,width:crop.width*k,height:crop.height*k};
  records.push({id:cell.id,view:'s',image,sourceWidth:crop.width,sourceHeight:crop.height,bounds,footprint:cell.footprint,surfaceSupport:cell.surfaceSupport,
   contact:{x:.5,y:(lastCoreY+.5)/crop.height,space:'exported-image-normalized',targetWorld:{x:cell.footprint.w*6,y:cell.footprint.h*12}},
   fit,underfill:{x:fit.width/bounds.width,y:fit.height/bounds.height},otherSupportedViewsUnchanged:cell.otherSupportedViewsUnchanged,
   source:sourcePath,sourceSha256:hash(sourceBytes),sourceCrop:{left:left+l,top:top+t,width:crop.width,height:crop.height},outputSha256:hash(png),
   alphaBounds:{x:0,y:0,width:crop.width,height:crop.height},alphaCounts:{transparent:zero,partial,opaque},maxSourceAlpha:maxAlpha,coreThreshold:180,edgeRadius:radius,removedFogPixels:removed,
   retainedRgbChanges:rgbChanges,retainedAlphaChanges:alphaChanges,opaqueCellEdgePixels:edgeCore,liveAccepted:false});
 }
 const receipt={version:1,count:records.length,scope:'Assigned catalog rest cohort; supported views from native contracts.',method:'Generated RGBA source preserved. Alpha>=180 core with radius3 preserves nearby original edge RGBA; remove detached fog/alpha1. Tight crop only, no RGB or retained alpha modification.',refs:layout.refs,records};
 fs.writeFileSync(docs+'/exports.json',JSON.stringify(receipt,null,2)+'\n');
 fs.writeFileSync(docs+'/integration.json',JSON.stringify({version:1,status:'candidate-not-integrated',records:records.map(({id,view,image,sourceWidth,sourceHeight,bounds,footprint,contact,surfaceSupport,otherSupportedViewsUnchanged})=>({id,view,image,sourceWidth,sourceHeight,bounds,footprint,contact,surfaceSupport,otherSupportedViewsUnchanged}))},null,2)+'\n');
 const composites=[];
 for(let i=0;i<records.length;i++){
  const a=records[i],w=Math.max(1,Math.round(a.fit.width*4)),h=Math.max(1,Math.round(a.fit.height*4));
  composites.push({input:await sharp(a.image).resize(w,h).png().toBuffer(),left:20+(i%4)*230+Math.floor((160-w)/2),top:35+Math.floor(i/4)*205});
  composites.push({input:Buffer.from('<svg width="185" height="22"><text x="0" y="16" fill="#dddcca" font-size="12">'+a.id+'</text></svg>'),left:10+(i%4)*230,top:5+Math.floor(i/4)*205});
 }
 await sharp({create:{width:930,height:410,channels:4,background:'#343c3c'}}).composite(composites).png().toFile(docs+'/fit-qa.png');
 console.log(JSON.stringify({count:records.length,fits:records.map(r=>({id:r.id,size:[r.sourceWidth,r.sourceHeight],fit:r.fit,underfill:r.underfill}))}));
})().catch(e=>{console.error(e);process.exitCode=1;});
