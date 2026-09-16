const fs=require('fs'),path=require('path'),sharp=require('sharp'),assert=require('assert');
const out='output/agent-animation-study/rollout-20px';
async function pack(input,dest){
 const{data,info}=await sharp(input).ensureAlpha().raw().toBuffer({resolveWithObject:true});let l=info.width,t=info.height,r=-1,b=-1;
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
 assert(r>=l&&b>=t,'Empty sprite');
 const crop=await sharp(input).extract({left:l,top:t,width:r-l+1,height:b-t+1}).resize({height:76}).png().toBuffer(),m=await sharp(crop).metadata();
 assert(m.width<100,'Unexpected body width');fs.mkdirSync(path.dirname(dest),{recursive:true});
 await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((144-m.width)/2),top:36}]).png().toFile(dest);
 return{width:m.width,height:76,worldHeight:19,worldWidth:m.width*19/76,foot:112};
}
(async()=>{
 const inputs=JSON.parse(fs.readFileSync(out+'/inputs.json')),manifest=JSON.parse(fs.readFileSync('frontend/agent-demo/manifest.json')),metrics={},layers=[];
 let i=0;for(const[id,input]of Object.entries(inputs)){
  fs.copyFileSync(input,out+'/'+id+'-source.png');
  for(const variant of ['new','earlier']){
   const rel=`assets/agent-demo/rollout-20px/${id}/${variant}.png`,source=variant==='new'?out+'/'+id+'-source.png':`frontend/assets/skin-study-0914/${id}/south.png`;
   metrics[id+'-'+variant]=await pack(source,'frontend/'+rel);const mirror='website/app/'+rel;fs.mkdirSync(path.dirname(mirror),{recursive:true});fs.copyFileSync('frontend/'+rel,mirror);
   manifest.sprites[(variant==='new'?'readability_':'industrial_')+id+'.rot.south']=['../agent-demo/rollout-20px/'+id+'/'+variant+'.png'];
   layers.push({input:'frontend/'+rel,left:i*144,top:variant==='new'?144:0});
  }i++;
 }
 for(const root of ['frontend','website/app'])fs.writeFileSync(root+'/agent-demo/manifest.json',JSON.stringify(manifest)+'\n');
 fs.writeFileSync(out+'/measurements.json',JSON.stringify(metrics,null,2)+'\n');
 await sharp({create:{width:i*144,height:288,channels:4,background:'#273237'}}).composite(layers).png().toFile(out+'/front-comparison.png');console.log(metrics);
})();
