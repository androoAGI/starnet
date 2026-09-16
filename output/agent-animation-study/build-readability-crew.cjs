const fs=require('fs'),path=require('path'),sharp=require('sharp'),assert=require('assert');
(async()=>{
 const out='output/agent-animation-study/readability-crew';fs.mkdirSync(out,{recursive:true});
 const inputs=JSON.parse(fs.readFileSync(out+'/inputs.json'));
 const manifest=JSON.parse(fs.readFileSync('frontend/agent-demo/manifest.json'));
 const results={};
 for(const[id,input]of Object.entries(inputs)){
  const src=out+'/'+id+'-source.png';fs.copyFileSync(input,src);
  const {data,info}=await sharp(src).ensureAlpha().raw().toBuffer({resolveWithObject:true});let l=info.width,t=info.height,r=-1,b=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
  assert(l>0&&t>0&&r<info.width-1&&b<info.height-1,'Transparent margins required');
  const crop=await sharp(src).extract({left:l,top:t,width:r-l+1,height:b-t+1}).resize({height:76}).png().toBuffer();const m=await sharp(crop).metadata();
  const rel='assets/agent-demo/readability-crew/'+id+'/front.png';fs.mkdirSync(path.dirname('frontend/'+rel),{recursive:true});
  await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((144-m.width)/2),top:36}]).png().toFile('frontend/'+rel);
  fs.mkdirSync(path.dirname('website/app/'+rel),{recursive:true});fs.copyFileSync('frontend/'+rel,'website/app/'+rel);
  manifest.sprites['readability_'+id+'.rot.south']=['../agent-demo/readability-crew/'+id+'/front.png'];
  results[id]={width:m.width,height:76,worldHeight:18,worldWidth:m.width*18/76,foot:112,source:input};
 }
 for(const prefix of ['frontend/','website/app/'])fs.writeFileSync(prefix+'agent-demo/manifest.json',JSON.stringify(manifest)+'\n');
 fs.writeFileSync(out+'/measurements.json',JSON.stringify(results,null,2)+'\n');console.log(results);
})().catch(e=>{console.error(e);process.exitCode=1});
