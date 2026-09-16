'use strict';
// Export-only preparation: remove the generated neutral background and crop.
// Subject RGB and aspect ratio are preserved; no repainting or sharpening.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),source=process.argv[2];
if(!source)throw Error('Pass the selected built-in imagegen PNG.');
(async()=>{
 const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const {width:w,height:h}=info,n=w*h,seen=new Uint8Array(n),queue=new Int32Array(n);let end=0,head=0;
 const visit=i=>{if(i<0||i>=n||seen[i])return;const p=i*4,lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);
  if(data[p+3]!==0&&(lo<145||hi-lo>25))return;seen[i]=1;queue[end++]=i;};
 for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
 while(head<end){const i=queue[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
 let l=w,t=h,r=-1,b=-1,opaque=0;
 for(let i=0;i<n;i++){if(seen[i]){data[i*4+3]=0;continue;}if(!data[i*4+3])continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);if(data[i*4+3]>250)opaque++;}
 const out=path.join(root,'frontend/assets/industrial/calibration');fs.mkdirSync(out,{recursive:true});
 const crop={left:l,top:t,width:r-l+1,height:b-t+1};
 await sharp(data,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toFile(path.join(out,'crate.png'));
 const metadata={source:path.basename(source),sourceDimensions:[w,h],crop,opaquePixels:opaque,subjectRgbChanges:0,
  nativeBody:{width:26,height:21,contactHeight:22,footprint:[24,12]},fit:'Uniform scale limited to width+2 and height+10; bottom at footprint ground edge. No bitmap rotation.'};
 fs.writeFileSync(path.join(root,'docs/station-remaster/CRATE-CALIBRATION.json'),JSON.stringify(metadata,null,2)+'\n');console.log(metadata);
})().catch(e=>{console.error(e);process.exitCode=1;});
