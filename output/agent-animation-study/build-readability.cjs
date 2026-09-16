const fs=require('fs'),sharp=require('sharp');
(async()=>{
 const out='output/agent-animation-study/readability-v1';fs.mkdirSync(out,{recursive:true});
 const src=out+'/source.png';fs.copyFileSync('C:/Users/andro/.codex/generated_images/01a09e2a-59d9-7333-ae0c-3d07653ddb14/exec-028aed27-90b9-4e19-b9a3-17a17ee4fe63.png',src);
 const {data,info}=await sharp(src).ensureAlpha().raw().toBuffer({resolveWithObject:true});let l=info.width,t=info.height,r=0,b=0;
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
 const crop=await sharp(src).extract({left:l,top:t,width:r-l+1,height:b-t+1}).resize({height:76}).png().toBuffer();const m=await sharp(crop).metadata();
 const dest='frontend/assets/agent-demo/readability-v1';fs.mkdirSync(dest,{recursive:true});
 await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((144-m.width)/2),top:36}]).png().toFile(dest+'/front.png');
 const manifest=JSON.parse(fs.readFileSync('frontend/agent-demo/manifest.json'));manifest.sprites['readability_secretagent.rot.south']=['../agent-demo/readability-v1/front.png'];fs.writeFileSync('frontend/agent-demo/manifest.json',JSON.stringify(manifest)+'\n');
 fs.writeFileSync(out+'/measurements.json',JSON.stringify({width:m.width,height:76,worldHeight:18,worldWidth:m.width*18/76,sourceBounds:{l,t,r,b},foot:112},null,2));
 console.log({width:m.width,height:76,worldHeight:18});
})();
