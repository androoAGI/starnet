'use strict';
// Mechanical atlas cropping and connected opaque matte removal only.
// All artwork is authored by imagegen from docs/station-remaster/bridge-reference.png.
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..');
const src=process.argv[2];
if(!src) throw Error('Pass the imagegen output directory.');
const out=path.join(root,'frontend/assets/industrial/remaster');
fs.mkdirSync(path.join(out,'walls'),{recursive:true});
async function prop(file,name) {
 const {data,info}=await sharp(path.join(src,file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const {width:w,height:h}=info,seen=new Uint8Array(w*h),q=new Int32Array(w*h);
 let n=0,head=0;
 const visit=i=>{ if(i<0||i>=w*h||seen[i])return; const p=i*4;
   if(Math.min(data[p],data[p+1],data[p+2])<145)return;
   seen[i]=1;q[n++]=i; };
 for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}
 for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
 while(head<n){const i=q[head++],x=i%w; if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
 let l=w,t=h,r=0,b=0;
 for(let i=0;i<w*h;i++){if(seen[i]){data.fill(0,i*4,i*4+4);continue;}if(!data[i*4+3])continue;
 const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
 await sharp(data,{raw:{width:w,height:h,channels:4}}).extract({left:l,top:t,width:r-l+1,height:b-t+1})
 .resize({width:Math.min(1024,r-l+1),withoutEnlargement:true}).png().toFile(path.join(out,name+'.png'));
 console.log(JSON.stringify({name,matte:n,bounds:[l,t,r,b]}));
}
(async()=>{
 // Re-encode compatibility albedos without changing decoded pixels.
 await sharp(path.join(src,'exec-9b476915-a43c-487b-b49a-d8af4447e932.png')).png({compressionLevel:9}).toFile(path.join(root,'frontend/assets/industrial/floor.png'));
 await sharp(path.join(src,'exec-d7e729e1-c11a-4bd6-ab20-800973a698a1.png')).png({compressionLevel:9}).toFile(path.join(root,'frontend/assets/industrial/wall.png'));
 const walls=['courses','service','plating','ribbed','panelled','pipework'];
 const atlas=path.join(src,'exec-511b18c4-7611-4da7-832d-a9d70d101ffa.png'),m=await sharp(atlas).metadata();
 for(let i=0;i<6;i++){const x=Math.round((i%3)*m.width/3),y=Math.round(Math.floor(i/3)*m.height/2);
 const right=Math.round((i%3+1)*m.width/3),bottom=Math.round((Math.floor(i/3)+1)*m.height/2);
 await sharp(atlas).extract({left:x,top:y,width:right-x,height:bottom-y}).png().toFile(path.join(out,'walls',walls[i]+'.png'));}
 await sharp(path.join(src,'exec-d7e729e1-c11a-4bd6-ab20-800973a698a1.png')).resize({width:1024}).png().toFile(path.join(out,'walls/bulkhead.png'));
 await sharp(path.join(src,'exec-f147e2cf-df83-4eef-a4ac-208d356594ed.png')).resize(1024,1024).png().toFile(path.join(out,'shell.png'));
 await prop('exec-f9d0e55c-2e45-4308-9465-c9924a9ea0c7.png','workstation-e');
 await prop('exec-d5ab323a-c96a-4b8c-b9a1-f42ac9f47c45.png','workstation-n');
 await prop('exec-4ce14e96-2e0d-4257-a2e8-03b66500001b.png','workstation-compact-n');
})();