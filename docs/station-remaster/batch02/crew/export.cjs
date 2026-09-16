'use strict';
// User-authorized deterministic packaging, adapted from coordinator exporter.
// Original RGB is retained; only connected background alpha and crop change.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../../../..'),dest=path.join(root,'frontend/assets/industrial/batch02/crew');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function run(id){
 const cfgPath=path.join(__dirname,id+'.json'),cfg=JSON.parse(fs.readFileSync(cfgPath)),srcPath=path.join(__dirname,id+'-source.png');
 const source=fs.readFileSync(srcPath),{data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const original=Buffer.from(data),w=info.width,h=info.height,n=w*h,seen=new Uint8Array(n),q=new Int32Array(n);let head=0,end=0;
 // Some generated RGBA sources have near-opaque bodies and faint distant residue.
 // An explicitly audited cutoff restores a solid prop without touching RGB.
 if(cfg.alphaCutoff)for(let i=0;i<n;i++)data[i*4+3]=data[i*4+3]>=cfg.alphaCutoff?255:0;
 const visit=i=>{if(i<0||i>=n||seen[i])return;const p=i*4,lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);if(data[p+3]>0&&(lo<(cfg.backgroundThreshold||235)||hi-lo>25))return;seen[i]=1;q[end++]=i;};
 for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
 for(const [x,y]of cfg.holeSeeds||[])visit(y*w+x);
 while(head<end){const i=q[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
 let l=w,t=h,r=-1,b=-1,removed=0;
 for(let i=0;i<n;i++){if(seen[i]){data[i*4+3]=0;removed++;}if(!data[i*4+3])continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
 if(r<l||!removed)throw Error('Invalid export '+id);
 const crop={left:l,top:t,width:r-l+1,height:b-t+1};fs.mkdirSync(dest,{recursive:true});const out=path.join(dest,id+'.png');
 await sharp(data,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toFile(out);
 const final=await sharp(out).raw().toBuffer({resolveWithObject:true});let transparent=0,opaque=0,partial=0,rgbChanges=0;
 for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){const d=(y*crop.width+x)*4,s=((y+t)*w+x+l)*4,a=final.data[d+3];if(a===0)transparent++;else if(a===255)opaque++;else partial++;for(let c=0;c<3;c++)if(final.data[d+c]!==original[s+c])rgbChanges++;}
 if(rgbChanges||!transparent||!opaque)throw Error('Invalid pixel verification '+id);
 const result={...cfg,id,sourceWidth:w,sourceHeight:h,sourceSha256:hash(source),output:'frontend/assets/industrial/batch02/crew/'+id+'.png',crop,transparentPixels:transparent,opaquePixels:opaque,partialPixels:partial,backgroundPixelsRemoved:removed,subjectRgbChanges:rgbChanges,outputSha256:hash(fs.readFileSync(out)),liveIntegrated:false};
 fs.writeFileSync(path.join(__dirname,id+'.export.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({id,crop,transparent,opaque,partial,rgbChanges}));
}
(async()=>{for(const id of process.argv.slice(2))await run(id);})().catch(e=>{console.error(e);process.exitCode=1;});
