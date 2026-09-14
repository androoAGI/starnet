'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),dir='frontend/assets/industrial/batch03/habitat/';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const list=JSON.parse(fs.readFileSync(path.join(root,'docs/station-remaster/batch03/habitat/sources.json')));
 const records=[];fs.mkdirSync(path.join(root,dir),{recursive:true});
 for(const a of list){
  const bytes=fs.readFileSync(path.join(root,a.source));
  const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const original=Buffer.from(data),w=info.width,h=info.height,n=w*h,seen=new Uint8Array(n),queue=new Int32Array(n);let head=0,end=0;
  const hasAlpha=data.some((v,i)=>i%4===3&&v<250);
  if(!hasAlpha){
   const visit=i=>{if(i<0||i>=n||seen[i])return;const p=i*4,lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);if(a.backgroundMode==='magenta'?!(data[p]>150&&data[p+2]>150&&data[p+1]<110&&data[p]-data[p+1]>70&&data[p+2]-data[p+1]>70):a.backgroundMode==='black'?hi>8:(lo<145||hi-lo>25))return;seen[i]=1;queue[end++]=i;};
   for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
   for(const [x,y]of a.seeds||[]){visit(y*w+x);if(!seen[y*w+x])throw Error('Invalid background seed '+a.id);}
   while(head<end){const i=queue[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
  }
  let l=w,t=h,r=-1,b=-1;
  for(let i=0;i<n;i++){if(seen[i]||data[i*4+3]<16)data[i*4+3]=0;if(!data[i*4+3])continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
  if(r<l)throw Error('Empty export '+a.id);
  const crop={left:l,top:t,width:r-l+1,height:b-t+1},output=dir+a.id+'.png';
  await sharp(data,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toFile(path.join(root,output));
  const final=await sharp(path.join(root,output)).raw().toBuffer({resolveWithObject:true});let transparent=0,opaque=0,partial=0,rgbChanges=0;
  for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){const dst=(y*crop.width+x)*4,src=((y+t)*w+x+l)*4,alpha=final.data[dst+3];if(!alpha)transparent++;else if(alpha===255)opaque++;else partial++;for(let c=0;c<3;c++)if(final.data[dst+c]!==original[src+c])rgbChanges++;}
  if(rgbChanges||!transparent||!opaque)throw Error('Export verification failed '+a.id);
  if(sha(fs.readFileSync(path.join(root,a.source)))!==sha(bytes))throw Error('Source mutated '+a.id);
  const record={...a,output,sourceWidth:w,sourceHeight:h,crop,sourceSha256:sha(bytes),outputSha256:sha(fs.readFileSync(path.join(root,output))),channels:4,transparentPixels:transparent,opaquePixels:opaque,partialPixels:partial,subjectRgbChanges:rgbChanges};records.push(record);console.log(a.id+' '+crop.width+'x'+crop.height+' transparent='+transparent+' RGB changes='+rgbChanges);
 }
 fs.writeFileSync(path.join(root,dir,'export-checks.json'),JSON.stringify({version:1,method:'User-authorized connected background extraction (declared key color); native alpha retained; original RGB preserved',records},null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

