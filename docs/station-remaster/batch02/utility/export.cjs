'use strict';
// Adapted from coordinator export-parallel-0914.cjs. User authorized deterministic
// alpha export. Retained RGB unchanged; no painted geometry or material changes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../../../..');
const assets='frontend/assets/industrial/batch02/utility';
const docs='docs/station-remaster/batch02/utility';
const specs=JSON.parse(fs.readFileSync(path.join(__dirname,'export-specs.json')));
const wanted=new Set(process.argv.slice(2));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
let records=fs.existsSync(path.join(__dirname,'export-checks.json'))?JSON.parse(fs.readFileSync(path.join(__dirname,'export-checks.json'))).records:[];
for(const a of specs.filter(a=>!wanted.size||wanted.has(a.id))){
const sourcePath=docs+'/sources/'+a.id+'.png',source=fs.readFileSync(path.join(root,sourcePath));
const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const original=Buffer.from(data),w=info.width,h=info.height,n=w*h,seen=new Uint8Array(n),queue=new Int32Array(n);let head=0,end=0;
const protectedPixel=(x,y)=>(a.protectRects||[]).some(r=>x>=r[0]&&y>=r[1]&&x<=r[2]&&y<=r[3]);
const visit=i=>{if(i<0||i>=n||seen[i])return;const x=i%w,y=Math.floor(i/w);if(protectedPixel(x,y))return;const p=i*4,lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);if(lo<(a.minNeutral??145)||hi-lo>(a.maxChroma??25))return;seen[i]=1;queue[end++]=i;};
for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
for(const [x,y] of a.seeds||[]){visit(y*w+x);if(!seen[y*w+x])throw Error('Invalid inspected hole seed '+a.id+' '+x+','+y);}
while(head<end){const i=queue[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
let l=w,t=h,r=-1,b=-1,removed=0;
for(let i=0;i<n;i++){if(seen[i]){data[i*4+3]=0;removed++;}if(!data[i*4+3])continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
if(r<l||!removed)throw Error('Invalid export '+a.id);
const output=assets+'/'+a.id+'.png';await sharp(data,{raw:{width:w,height:h,channels:4}}).png().toFile(path.join(root,output));
const final=await sharp(path.join(root,output)).raw().toBuffer({resolveWithObject:true});let transparent=0,opaque=0,partial=0,rgbChanges=0;
for(let i=0;i<n;i++){const p=i*4,alpha=final.data[p+3];if(alpha===0)transparent++;else if(alpha===255)opaque++;else partial++;for(let c=0;c<3;c++)if(final.data[p+c]!==original[p+c])rgbChanges++;}
if(rgbChanges||!transparent||!opaque)throw Error('Export verification failed '+a.id);
if(hash(fs.readFileSync(path.join(root,sourcePath)))!==hash(source))throw Error('Source changed '+a.id);
const record={...a,source:sourcePath,sourceSha256:hash(source),sourceWidth:w,sourceHeight:h,output,canvasPreserved:true,alphaBounds:{x:l,y:t,width:r-l+1,height:b-t+1},channels:4,transparentPixels:transparent,opaquePixels:opaque,partialPixels:partial,backgroundPixelsRemoved:removed,subjectRgbChanges:rgbChanges,outputSha256:hash(fs.readFileSync(path.join(root,output)))};
records=records.filter(x=>x.id!==a.id).concat(record);console.log(JSON.stringify(record));
}fs.writeFileSync(path.join(__dirname,'export-checks.json'),JSON.stringify({version:1,authorization:'User explicitly proceeded with deterministic exporter 2026-09-14',method:'Light-neutral flood fill with inspected enclosed-hole seeds; original RGB and canvas preserved',records},null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
