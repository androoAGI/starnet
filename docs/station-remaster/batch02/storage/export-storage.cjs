'use strict';
// User-authorized adaptation of export-parallel-0914.cjs.
// Magenta connected-component masking preserves pale paper/ceramic and every retained RGB byte.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../../../..'),docs=path.join(root,'docs/station-remaster/batch02/storage'),out=path.join(root,'frontend/assets/industrial/batch02/storage');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const ids=process.argv.slice(2);if(!ids.length)throw Error('Pass explicit owned IDs');
const structure=JSON.parse(fs.readFileSync(path.join(root,'dev/industrial-textures/prop-structure-manifest.json')));
const inventory=JSON.parse(fs.readFileSync(path.join(root,'dev/industrial-textures/prop-inventory.json')));
async function main(){for(const id of ids){
const sourcePath=path.join(docs,'sources',id+'.png'),source=fs.readFileSync(sourcePath);
const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const original=Buffer.from(data),w=info.width,h=info.height,n=w*h,seen=new Uint8Array(n),queue=new Int32Array(n);
let head=0,end=0,components=0;
const key=i=>{const p=i*4;return data[p]-data[p+1]>30&&data[p+2]-data[p+1]>30&&data[p]+data[p+2]>180;};
const visit=i=>{if(i<0||i>=n||seen[i]||!key(i))return;seen[i]=1;queue[end++]=i;};
for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
const drain=()=>{while(head<end){const i=queue[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}};
drain();
// Input art deliberately excludes magenta materials. Inspect each enclosed key component (e.g. mug handle).
const holeSeeds=[];for(let i=0;i<n;i++)if(!seen[i]&&key(i)){holeSeeds.push([i%w,Math.floor(i/w)]);visit(i);drain();components++;}
let l=w,t=h,r=-1,b=-1,removed=0;for(let i=0;i<n;i++){if(seen[i]){data[i*4+3]=0;removed++;}if(!data[i*4+3])continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
if(r<l||!removed)throw Error('Invalid export '+id);
const crop={left:l,top:t,width:r-l+1,height:b-t+1},outputPath=path.join(out,id+'.png');
await sharp(data,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toFile(outputPath);
const final=await sharp(outputPath).raw().toBuffer({resolveWithObject:true});let transparent=0,opaque=0,partial=0,rgbChanges=0;
for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){const dst=(y*crop.width+x)*4,src=((y+t)*w+x+l)*4,a=final.data[dst+3];if(!a)transparent++;else if(a===255)opaque++;else partial++;for(let c=0;c<3;c++)if(final.data[dst+c]!==original[src+c])rgbChanges++;}
if(rgbChanges||partial||!transparent||!opaque||hash(fs.readFileSync(sourcePath))!==hash(source))throw Error('Verification failed '+id);
const spec=structure.props[id].views.s,inv=inventory.props.find(p=>p.id===id);
const record={id,status:'exported-awaiting-owner-live-review',source:'sources/'+id+'.png',sourceSha256:hash(source),sourceWidth:w,sourceHeight:h,image:id+'.png',sourceOutputWidth:crop.width,sourceOutputHeight:crop.height,crop,channels:4,transparentPixels:transparent,opaquePixels:opaque,partialPixels:partial,backgroundPixelsRemoved:removed,subjectRgbChanges:rgbChanges,outputSha256:hash(fs.readFileSync(outputPath)),holeSeeds,maskMethod:'Connected saturated-magenta flood fill, including key-only enclosed components. Alpha-only edits; uniform crop; no RGB recolor.',view:'s',footprint:spec.footprint,bounds:spec.bounds,tilePixels:12,contact:{x:spec.bounds.x+spec.bounds.width/2,y:spec.bounds.y+spec.bounds.height},anchorContract:inv.anchorContract,originalLight:inv.light,originalAnimationTriggers:inv.liveAnimationTriggers,artMode:'static complete art; existing state/lighting integration remains owner decision',liveIntegrated:false};
fs.writeFileSync(path.join(docs,id+'.export.json'),JSON.stringify(record,null,2)+'\n');
await sharp(outputPath).resize({width:Math.round(spec.bounds.width*4),height:Math.round(spec.bounds.height*4),fit:'inside'}).png().toFile(path.join(docs,id+'.scale.png'));
console.log(JSON.stringify({id,width:crop.width,height:crop.height,transparent,opaque,rgbChanges,components}));
}}
main().catch(e=>{console.error(e);process.exitCode=1;});
