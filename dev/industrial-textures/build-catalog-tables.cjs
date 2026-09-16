'use strict';
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const dir='docs/station-remaster/catalog-tables',out='frontend/assets/industrial/catalog-tables',source=dir+'/sheet-source.png',structure=JSON.parse(fs.readFileSync('dev/industrial-textures/prop-structure-manifest.json'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
// ROIs and usable tabletop corners measured on the generated source, not guessed from cell order.
const items=[
 ['lowtable','s',[100,60,600,270],[[152,110],[620,110],[627,190],[150,190]]],
 ['lowtable','e',[760,10,230,330],[[806,49],[916,49],[916,242],[803,242]]],
 ['glasstable','s',[90,400,600,260],[[148,458],[630,458],[630,543],[148,543]]],
 ['loungetable','s',[150,740,490,270],[[218,802],[563,802],[563,885],[218,885]]],
 ['loungetable','e',[740,710,260,300],[[806,769],[925,769],[925,905],[806,905]]],
 ['longtable','s',[65,1060,650,300],[[127,1110],[652,1110],[654,1190],[123,1190]]],
 ['longtable','e',[750,1000,250,425],[[803,1052],[922,1052],[923,1269],[798,1269]]]
];
(async()=>{
 const bytes=fs.readFileSync(source),decoded=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true}),records=[];
 for(const [id,view,[left,top,width,height],points]of items){
  const raw=Buffer.alloc(width*height*4),core=new Uint8Array(width*height),outside=new Uint8Array(width*height),queue=[];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,j=((top+y)*decoded.info.width+left+x)*4;decoded.data.copy(raw,i,j,j+4);core[y*width+x]=raw[i+3]>=180?1:0;}
  const visit=(x,y)=>{const i=y*width+x;if(!core[i]&&!outside[i]){outside[i]=1;queue.push(i);}};
  for(let x=0;x<width;x++){visit(x,0);visit(x,height-1);}for(let y=0;y<height;y++){visit(0,y);visit(width-1,y);}
  for(let q=0;q<queue.length;q++){const i=queue[q],x=i%width,y=Math.floor(i/width);if(x)visit(x-1,y);if(x+1<width)visit(x+1,y);if(y)visit(x,y-1);if(y+1<height)visit(x,y+1);}
  let l=width,t=height,r=-1,b=-1,contactY=-1,retained=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x,d=i*4;let keep=raw[d+3]>1&&(!outside[i]||core[i]);if(core[i])contactY=Math.max(contactY,y);
   if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-3);yy<=Math.min(height-1,y+3)&&!keep;yy++)for(let xx=Math.max(0,x-3);xx<=Math.min(width-1,x+3);xx++)if(core[yy*width+xx]&&(xx-x)**2+(yy-y)**2<=9){keep=true;break;}
   if(!keep){raw[d+3]=0;continue;}retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
  }
  if(r<l)throw Error('Empty '+id);const sw=r-l+1,sh=b-t+1,png=await sharp(raw,{raw:{width,height,channels:4}}).extract({left:l,top:t,width:sw,height:sh}).png().toBuffer(),image=id+(view==='s'?'':'-'+view)+'.png';fs.writeFileSync(out+'/'+image,png);
  const native=structure.props[id].views[view],surfaceSupport={space:'export-normalized',points:points.map(([x,y])=>[(x-left-l)/sw,(y-top-t)/sh])};
  if(surfaceSupport.points.flat().some(n=>n<0||n>1))throw Error('Tabletop point outside '+id);
  records.push({id,view,image,repoPath:out+'/'+image,sourceWidth:sw,sourceHeight:sh,footprint:native.footprint,bounds:native.bounds,contact:{x:.5,y:(contactY+1-t)/sh},surfaceSupport,source,sourceSha256:hash(bytes),sourceCrop:{left:left+l,top:top+t,width:sw,height:sh},outputSha256:hash(png),retained,status:'Source and geometry candidate; room placement requires review'});
 }
 fs.writeFileSync(dir+'/integration.json',JSON.stringify({version:1,records},null,2)+'\n');console.log(records.map(r=>({id:r.id,view:r.view,source:[r.sourceWidth,r.sourceHeight],bounds:r.bounds})));
})().catch(e=>{console.error(e);process.exitCode=1;});
