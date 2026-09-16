'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
let sharp;try{sharp=require('sharp');}catch(_){sharp=require('C:/Users/andro/gen-trees/industrial-textures-0912/node_modules/sharp');}
const docs='docs/station-remaster/catalog-glass-fix',root='frontend/assets/industrial/catalog-glass-fix';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const glass=[[398,120],[644,120],[660,1086],[387,1086]]; // Visually traced usable inner pane in selected-source pixels, TL/TR/BR/BL.
const inside=(x,y)=>glass.every((a,i)=>{const b=glass[(i+1)%4];return(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0])>=0;});
(async()=>{
 const source=docs+'/selected-source.png',bytes=fs.readFileSync(source),s=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const w=s.info.width,h=s.info.height,raw=Buffer.from(s.data),core=new Uint8Array(w*h);
 let ol=w,ot=h,or=-1,ob=-1;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(raw[(y*w+x)*4+3]>=180){core[y*w+x]=1;ol=Math.min(ol,x);ot=Math.min(ot,y);or=Math.max(or,x);ob=Math.max(ob,y);}
 const opaque={x:ol,y:ot,width:or-ol+1,height:ob-ot+1},ratio=opaque.width/opaque.height;
 if(Math.abs(ratio-1/3)>.025)throw Error('Opaque source ratio fails: '+ratio);
 let l=w,t=h,r=-1,b=-1,removed=0,glassPixels=0;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const d=(y*w+x)*4,pane=inside(x,y);if(pane)glassPixels++;
  let keep=!!core[y*w+x]||(pane&&raw[d+3]>0);
  if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-3);yy<=Math.min(h-1,y+3)&&!keep;yy++)for(let xx=Math.max(0,x-3);xx<=Math.min(w-1,x+3);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=9){keep=true;break;}
  if(!keep){if(raw[d+3])removed++;raw[d+3]=0;continue;}
  l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
 }
 const width=r-l+1,height=b-t+1,png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract({left:l,top:t,width,height}).png().toBuffer();
 fs.writeFileSync(root+'/glasstable-e.png',png);
 const out=await sharp(png).ensureAlpha().raw().toBuffer();let allRGBMismatches=0,retainedRGBAMismatches=0,glassRGBAMismatches=0,retained=0,transparent=0;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const d=(y*width+x)*4,q=((y+t)*w+x+l)*4;
  for(let c=0;c<3;c++)if(out[d+c]!==s.data[q+c])allRGBMismatches++;
  if(out[d+3]){retained++;for(let c=0;c<4;c++)if(out[d+c]!==s.data[q+c])retainedRGBAMismatches++;}else transparent++;
  if(inside(x+l,y+t))for(let c=0;c<4;c++)if(out[d+c]!==s.data[q+c])glassRGBAMismatches++;
 }
 if(allRGBMismatches||retainedRGBAMismatches||glassRGBAMismatches||!transparent)throw Error('Pixel-preservation check failed');
 const points=glass.map(([x,y])=>[(x-l)/width,(y-t)/height]),contact={x:.5,y:(ob+1-t)/height},bounds={x:0,y:0,width:12,height:36};
 const k=Math.min(12/width,36/height),fit={x:(12-width*k)/2,y:36-contact.y*height*k,width:width*k,height:height*k};
 const record={id:'glasstable',view:'e',image:'glasstable-e.png',repoPath:root+'/glasstable-e.png',sourceWidth:width,sourceHeight:height,
  footprint:{w:1,h:3},bounds,contact,mode:'approved',effects:false,surfaceSupport:{space:'export-normalized',points},source,sourceSha256:hash(bytes),outputSha256:hash(png),
  sourceROI:{left:0,top:0,width:w,height:h},sourceCrop:{left:l,top:t,width,height},actualFit:fit,
  opaqueBoundsInSource:opaque,opaqueWidthHeightRatio:ratio,opaqueHeightWidthRatio:1/ratio,
  verification:{retained,transparent,removedAlpha:removed,allRGBMismatches,retainedRGBAMismatches,glassRGBAMismatches,glassPixels},
  status:'source/crop/game-scale/usable pane inspected; root owns live mounting verification'};
 fs.writeFileSync(docs+'/integration.json',JSON.stringify({version:1,records:[record]},null,2)+'\n');
 const overlay=Buffer.from(`<svg width="${width}" height="${height}"><polygon points="${glass.map(([x,y])=>[x-l,y-t].join(',')).join(' ')}" fill="#ff880022" stroke="#ff8822" stroke-width="4"/></svg>`);
 const marked=await sharp(png).composite([{input:overlay}]).png().toBuffer();
 await sharp(marked).resize({height:800}).png().toFile(docs+'/surface-proof.png');
 const parts=[];for(const [scale,left]of [[1,15],[2,75],[4,170]])parts.push({input:await sharp(png).resize(Math.round(fit.width*scale),Math.round(fit.height*scale)).png().toBuffer(),left,top:180-Math.round(fit.height*scale)});
 await sharp({create:{width:250,height:205,channels:4,background:'#333b3c'}}).composite(parts).png().toFile(docs+'/game-scale-proof.png');
 console.log(JSON.stringify(record,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
