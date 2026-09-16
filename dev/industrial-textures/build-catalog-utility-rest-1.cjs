'use strict';
// Offline packaging only. Retained source RGBA bytes are never painted or rescaled.
const fs=require('node:fs'),crypto=require('node:crypto');
let sharp;try{sharp=require('sharp');}catch(_){sharp=require('C:/Users/andro/gen-trees/industrial-textures-0912/node_modules/sharp');}
const root='frontend/assets/industrial/catalog-utility-rest-1',docs='docs/station-remaster/catalog-utility-rest-1';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const items=[
 ['bay',10,35,465,450],['filter',480,90,315,385],['joiner',805,200,395,280],['loop',1210,80,325,400],
 ['merger',20,640,400,265],['splitter',440,640,360,280],['outbox',810,490,440,465],['connector_portal',0,0,0,0,'connector-source']
];
const f=n=>+n.toFixed(6);
(async()=>{
 const structure=JSON.parse(fs.readFileSync('dev/industrial-textures/prop-structure-manifest.json')).props;
 const records=[];fs.mkdirSync(root,{recursive:true});
 for(const [id,left,top,rw,rh,selected='sheet-source']of items){
  const source=docs+'/'+selected+'.png',bytes=fs.readFileSync(source),decoded=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const w=rw||decoded.info.width,h=rh||decoded.info.height;
  const raw=Buffer.alloc(w*h*4),core=new Uint8Array(w*h);let contactBottom=-1,removedAlpha=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const d=(y*w+x)*4,q=((top+y)*decoded.info.width+left+x)*4;
   decoded.data.copy(raw,d,q,q+4);
   if(raw[d+3]>=180){core[y*w+x]=1;contactBottom=Math.max(contactBottom,y);}
  }
  let l=w,t=h,r=-1,b=-1,retained=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const d=(y*w+x)*4;let keep=!!core[y*w+x];
   if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-3);yy<=Math.min(h-1,y+3)&&!keep;yy++)
    for(let xx=Math.max(0,x-3);xx<=Math.min(w-1,x+3);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=9){keep=true;break;}
   if(!keep){if(raw[d+3])removedAlpha++;raw[d+3]=0;continue;}
   retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
  }
  if(r<l||contactBottom<0)throw Error('Empty export '+id);
  const width=r-l+1,height=b-t+1,image=id+'.png';
  const png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract({left:l,top:t,width,height}).png().toBuffer();
  fs.writeFileSync(root+'/'+image,png);
  const check=await sharp(png).ensureAlpha().raw().toBuffer();let transparent=0,nonzero=0,rgbaMismatches=0,rgbMismatches=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const d=(y*width+x)*4,q=((top+t+y)*decoded.info.width+left+l+x)*4;
   for(let c=0;c<3;c++)if(check[d+c]!==decoded.data[q+c])rgbMismatches++;
   if(!check[d+3])transparent++;else{nonzero++;for(let c=0;c<4;c++)if(check[d+c]!==decoded.data[q+c])rgbaMismatches++;}
  }
  if(!transparent||!nonzero||rgbaMismatches||rgbMismatches)throw Error('RGBA verification failed '+id);
  const native=structure[id].views.s,bounds={...native.bounds},contact={x:.5,y:(contactBottom+1-t)/height};
  const scale=Math.min(bounds.width/width,bounds.height/height);
  if(width*scale<bounds.width*.9)throw Error('Source too narrow '+id);
  records.push({id,view:'s',image,repoPath:root+'/'+image,sourceWidth:width,sourceHeight:height,
   footprint:native.footprint,bounds,contact,mode:'approved',effects:false,
   source,sourceSha256:sha(bytes),outputSha256:sha(png),sourceROI:{left,top,width:w,height:h},
   sourceCrop:{left:left+l,top:top+t,width,height},
   actualFit:{x:f(bounds.x+(bounds.width-width*scale)/2),y:f(bounds.y+bounds.height-contact.y*height*scale),width:f(width*scale),height:f(height*scale)},
   verification:{transparent,retained:nonzero,removedAlpha,retainedRGBAMismatches:rgbaMismatches,allRGBMismatches:rgbMismatches,widthFraction:f(width*scale/bounds.width)},
   status:'source and game-scale candidate reviewed; not live integrated; image-specific effect regions need remapping'});
 }
 fs.writeFileSync(docs+'/integration.json',JSON.stringify({version:1,records},null,2)+'\n');
 console.log(records.map(r=>({id:r.id,size:[r.sourceWidth,r.sourceHeight],fit:r.actualFit,verification:r.verification})));
 // Review-only raster: each cell shows old2x, new2x and new4x at true world scale.
 const layers=[],labels=[],cellW=450,cellH=225;
 for(let i=0;i<records.length;i++){
  const r=records[i],ox=(i%2)*cellW,oy=Math.floor(i/2)*cellH;
  labels.push(`<text x="${ox+10}" y="${oy+20}" fill="#d8d5cd">${r.id} — old 2× / new 2× / new 4×</text>`);
  const oldManifest=JSON.parse(fs.readFileSync('frontend/assets/industrial/approved-sheet/manifest.json')).props;
  const old=oldManifest[r.id].views.s;
  for(const [file,fit,mult,x]of [[`frontend/assets/industrial/approved-sheet/${old.image}`,old.bounds,2,ox+10],[root+'/'+r.image,r.actualFit,2,ox+120],[root+'/'+r.image,r.actualFit,4,ox+260]]){
   const img=await sharp(file).resize(Math.max(1,Math.round(fit.width*mult)),Math.max(1,Math.round(fit.height*mult)),{fit:'fill',kernel:'lanczos3'}).png().toBuffer();
   layers.push({input:img,left:x,top:oy+205-Math.round(fit.height*mult)});
  }
 }
 const label=Buffer.from(`<svg width="900" height="900"><style>text{font:14px sans-serif}</style>${labels.join('')}</svg>`);
 layers.push({input:label,left:0,top:0});
 await sharp({create:{width:900,height:900,channels:4,background:'#333b3c'}}).composite(layers).png().toFile(docs+'/game-scale-proof.png');
})().catch(e=>{console.error(e);process.exitCode=1;});
