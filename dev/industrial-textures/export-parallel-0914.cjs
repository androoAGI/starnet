'use strict';
// User-authorized packaging of built-in imagegen sources. Uses the existing
// prop-art-tools.cjs light-neutral flood fill, including inspected hole seeds.
// Source files and retained RGB are unchanged. No tracing or painted new detail.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..');
const base='frontend/assets/industrial/parallel-0914/';
const list=[
 {id:'bookshelf',source:base+'storage/bookshelf.png',seeds:[]},
 {id:'boxes',source:base+'storage/boxes.png',seeds:[]},
 {id:'couch',source:base+'crew/couch.png',seeds:[]},
 {id:'lowtable',source:base+'crew/lowtable.png',seeds:[[950,500]]},
 {id:'lowtable-r3',source:base+'crew/lowtable-r3.png',seeds:[]},
 {id:'filter',source:base+'utility/filter.png',seeds:[[540,580]]},
 // Use the intact RGB generation to avoid the subsequent model extraction's
 // semiopaque body and distant faint alpha residue.
 {id:'tank',source:'docs/station-remaster/parallel-0914/utility/tank-source.png',seeds:[]}
];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const out=path.join(root,base,'exports');fs.mkdirSync(out,{recursive:true});
 const records=[];
 for(const a of list){
  const source=fs.readFileSync(path.join(root,a.source));
  const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const original=Buffer.from(data),w=info.width,h=info.height,n=w*h;
  const seen=new Uint8Array(n),queue=new Int32Array(n);let head=0,end=0;
  const visit=i=>{if(i<0||i>=n||seen[i])return;const p=i*4,lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);if(lo<145||hi-lo>25)return;seen[i]=1;queue[end++]=i;};
  for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
  for(const [x,y]of a.seeds){visit(y*w+x);if(!seen[y*w+x])throw Error('Not a light-neutral hole seed '+a.id);}
  while(head<end){const i=queue[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
  let l=w,t=h,r=-1,b=-1,removed=0;
  for(let i=0;i<n;i++){if(seen[i]){data[i*4+3]=0;removed++;}if(data[i*4+3]===0)continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
  if(r<l||!removed)throw Error('Invalid export '+a.id);
  const crop={left:l,top:t,width:r-l+1,height:b-t+1},output=base+'exports/'+a.id+'.png';
  await sharp(data,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toFile(path.join(root,output));
  const final=await sharp(path.join(root,output)).raw().toBuffer({resolveWithObject:true});
  let transparent=0,opaque=0,partial=0,rgbChanges=0;
  for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
   const dst=(y*crop.width+x)*4,src=((y+t)*w+x+l)*4,alpha=final.data[dst+3];
   if(alpha===0)transparent++;else if(alpha===255)opaque++;else partial++;
   for(let c=0;c<3;c++)if(final.data[dst+c]!==original[src+c])rgbChanges++;
  }
  if(rgbChanges||partial||!transparent||!opaque)throw Error('Export verification failed '+a.id);
  if(hash(fs.readFileSync(path.join(root,a.source)))!==hash(source))throw Error('Source changed '+a.id);
  const record={...a,sourceSha256:hash(source),sourceWidth:w,sourceHeight:h,output,crop,channels:4,transparentPixels:transparent,opaquePixels:opaque,partialPixels:partial,backgroundPixelsRemoved:removed,subjectRgbChanges:rgbChanges,outputSha256:hash(fs.readFileSync(path.join(root,output)))};
  records.push(record);console.log(JSON.stringify(record));
 }
 fs.writeFileSync(path.join(out,'export-checks.json'),JSON.stringify({version:1,authorization:'User proceeded with existing exporter after explicit request, 2026-09-14',method:'Existing light-neutral connected flood fill; preserved RGB; uniform crop only',records},null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
