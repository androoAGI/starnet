const fs=require('fs');
const sharp=require('sharp');
const path=require('path');
const names=['ultron','skeleton','plaguedoctor','secretagent','voidwizard'];
(async()=>{ const file=path.join(__dirname,'source-alpha.png');const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
for(let i=0;i<5;i++){let l=info.width,t=info.height,r=0,b=0;for(let y=0;y<info.height;y++)for(let x=[0,350,700,1050,1390][i];x<[350,700,1050,1390,info.width][i];x++){if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}}
const crop=await sharp(file).extract({left:l,top:t,width:r-l+1,height:b-t+1}).resize({height:76}).png().toBuffer();const m=await sharp(crop).metadata();await sharp({create:{width:96,height:96,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((96-m.width)/2),top:12}]).png().toFile(path.join(__dirname,names[i]+'-reference.png'));console.log(names[i],l,t,r,b);}
})();

