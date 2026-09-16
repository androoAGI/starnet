const fs=require('fs'),path=require('path'),sharp=require('sharp');
const dest=path.resolve(__dirname,'proportions-v1');fs.mkdirSync(dest,{recursive:true});
const src='C:/Users/andro/.codex/generated_images/01a09e2a-59d9-7333-ae0c-3d07653ddb14/';
const files={a:'exec-9ce7b8e4-8e18-4e6b-8040-e1bbd5bc43d6.png',b:'exec-fec82c23-6935-4da4-acf8-ac023151e7e9.png',c:'exec-6f6428f5-cd14-4fb2-8712-f70f75a6b305.png'};
(async()=>{const result={};for(const[id,file]of Object.entries(files)){
 const original=path.join(dest,id+'-source.png');fs.copyFileSync(src+file,original);
 const{data,info}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let l=info.width,t=info.height,r=-1,b=-1;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
 if(l===0&&t===0&&r===info.width-1&&b===info.height-1)throw Error('Expected genuine transparent source: '+id);
 const crop=await sharp(original).extract({left:l,top:t,width:r-l+1,height:b-t+1}).resize({height:76,kernel:'lanczos3'}).png().toBuffer();const m=await sharp(crop).metadata();
 const out=path.join(dest,id+'-reference.png');await sharp({create:{width:96,height:96,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((96-m.width)/2),top:12}]).png().toFile(out);
 result[id]={source:file,width:m.width,height:76,bodyWorldHeight:18};
 }fs.writeFileSync(path.join(dest,'measurements.json'),JSON.stringify(result,null,2));console.log(result);})().catch(e=>{console.error(e);process.exitCode=1});
