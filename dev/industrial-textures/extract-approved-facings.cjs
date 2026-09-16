'use strict';
// Run from this worktree root with sharp on NODE_PATH, like extract-approved-sheet.cjs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const docs='docs/station-remaster/approved-sheet/crew',out='frontend/assets/industrial/approved-sheet';
const map=JSON.parse(fs.readFileSync(docs+'/facings-cellmap.json','utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const overrides={
  'industrial_partition-e':docs+'/sources/partition-e.png',
  'longtable-e':docs+'/sources/longtable-e.png'
};
const cache=new Map();
async function source(file){
  if(cache.has(file))return cache.get(file);
  const bytes=fs.readFileSync(file),value={file,sha256:hash(bytes),...await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true})};
  if(file===map.source&&value.sha256!==map.sha256)throw Error('Facing sheet changed');
  cache.set(file,value);return value;
}
async function extract(cell){
  const name=cell.mappedId+'-'+cell.mappedView,override=overrides[name];
  if(override&&!fs.existsSync(override))return {name,status:'withheld-until-repair',missingSource:override};
  const src=await source(override||map.source),info=src.info,data=src.data;
  const nominal=override?{x:0,y:0,width:info.width,height:info.height}:cell.cellBounds;
  const cut=(axis,n,lo,hi)=>{
    const limit=axis==='x'?info.width:info.height;if(n===0||n===limit)return n;
    let best=n,score=Infinity;
    for(let k=Math.max(0,n-12);k<=Math.min(limit-1,n+12);k++){
      let sum=0;for(let v=lo;v<hi;v++){const a=data[((axis==='x'?v:k)*info.width+(axis==='x'?k:v))*4+3];if(a>40)sum+=a;}
      const weighted=sum+Math.abs(k-n)*.001;if(weighted<score){score=weighted;best=k;}
    }return best;
  };
  const left=cut('x',nominal.x,nominal.y,nominal.y+nominal.height),right=cut('x',nominal.x+nominal.width,nominal.y,nominal.y+nominal.height);
  const top=cut('y',nominal.y,left,right),bottom=cut('y',nominal.y+nominal.height,left,right);
  const w=right-left,h=bottom-top,raw=Buffer.alloc(w*h*4),core=new Uint8Array(w*h),radius=3,threshold=180;
  let opaqueEdge=0,maxAlpha=0,corePixels=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const s=((y+top)*info.width+x+left)*4,d=(y*w+x)*4;data.copy(raw,d,s,s+4);const a=raw[d+3];maxAlpha=Math.max(maxAlpha,a);
    if(a>=threshold){core[y*w+x]=1;corePixels++;if(!x||!y||x===w-1||y===h-1)opaqueEdge++;}
  }
  if(!corePixels)throw Error('No alpha>=180 core; inspect source before lowering threshold: '+name);
  let l=w,t=h,r=-1,b=-1,removed=0,retained=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const d=(y*w+x)*4;if(!raw[d+3])continue;let keep=!!core[y*w+x];
    if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-radius);yy<=Math.min(h-1,y+radius)&&!keep;yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(w-1,x+radius);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=radius*radius){keep=true;break;}
    if(!keep){raw[d+3]=0;removed++;continue;}retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
  }
  if(r<l)throw Error('Empty '+name);
  const crop={left:l,top:t,width:r-l+1,height:b-t+1},output=out+'/'+name+'.png';
  const png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toBuffer();fs.writeFileSync(output,png);
  const final=await sharp(png).ensureAlpha().raw().toBuffer();let rgbChanges=0,alphaChanges=0,zero=0,partial=0,opaque=0;
  for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
    const d=(y*crop.width+x)*4,s=((y+top+t)*info.width+x+left+l)*4,a=final[d+3];
    if(!a){zero++;continue;}if(a===255)opaque++;else partial++;
    for(let c=0;c<3;c++)if(final[d+c]!==data[s+c])rgbChanges++;
    if(a!==data[s+3])alphaChanges++;
  }
  if(rgbChanges||alphaChanges||opaqueEdge)throw Error('Body preservation / cell edge failure '+name);
  const bounds=cell.nativeBounds,scale=Math.min(bounds.width/crop.width,bounds.height/crop.height);
  return {id:cell.mappedId,view:cell.mappedView,name,status:'exported-not-live-verified',output,outputSha256:hash(png),source:src.file,sourceSha256:src.sha256,
    sourceRect:{left,top,width:w,height:h},sourceCrop:{left:left+l,top:top+t,width:crop.width,height:crop.height},width:crop.width,height:crop.height,
    alphaBounds:{x:0,y:0,width:crop.width,height:crop.height},retainedPixels:retained,alphaResidueRemoved:removed,retainedRgbChanges:rgbChanges,retainedAlphaChanges:alphaChanges,
    maxSourceAlpha:maxAlpha,coreThreshold:threshold,edgeRadius:radius,opaqueCellEdgePixels:opaqueEdge,alphaCounts:{transparent:zero,partial,opaque},nativeFootprint:cell.nativeFootprint,nativeBounds:bounds,
    uniformFit:{x:bounds.x+(bounds.width-crop.width*scale)/2,y:bounds.y+bounds.height-crop.height*scale,width:crop.width*scale,height:crop.height*scale},repairSourceUsed:!!override};
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});const records=[];for(const cell of map.cells)records.push(await extract(cell));
  const result={version:1,method:'Same alpha>=180 core and radius3 support-preserving removal as parent extractor; retained body RGB/alpha exact. Remove detached haze and alpha1, tight crop, no rescale/recolour/bitmap-facing transforms.',
    count:records.filter(r=>r.output).length,requestedCount:map.count,partitionRepair:'Native F industrial_partition:e has opposite west via viewAt mirror fallback (propsprites.js:11062); source pair duplicated visually. New AI-authored opposite source substitutes e; original retained as w.',
    longtableRepair:'Dedicated bare east table replaces initial baked-chair assembly. Source override supplies bare same-style top/legs.',
    repairProvenance:{
      partition:{prompt:docs+'/partition-opposite.prompt.txt',primaryReference:'frontend/assets/industrial/complete-sheet/starnet-props-full-sheet.png',secondaryReference:map.source},
      longtable:{prompt:docs+'/longtable-e.prompt.txt',primaryReference:'frontend/assets/industrial/complete-sheet/starnet-props-full-sheet.png',secondaryReference:'docs/station-remaster/approved-sheet/storage/repair-sheet-source.png',matchingCell:'top row far right bare longtable'}
    },
    integrationNotes:[
      'Uniform fits are measured, not resized to match native bounds. Partition-e repair has a broader aspect than the native narrow 8x44 envelope, so it draws shorter than partition-w at equal width; do not stretch silently.',
      'Desk sprites include operator chairs and dinertable includes surrounding chairs as in their source assemblies. Integration must account for these occupied surfaces instead of adding duplicate baked seating.',
      'True opposite direction and bare longtable verified visually in fitted QA; no live occupancy, camera or collision verification performed.'
    ],records};
  fs.writeFileSync(docs+'/facings-extraction.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({count:result.count,withheld:records.filter(r=>!r.output),sizes:records.filter(r=>r.output).map(r=>[r.name,r.width,r.height])}));
})().catch(e=>{console.error(e);process.exitCode=1;});
