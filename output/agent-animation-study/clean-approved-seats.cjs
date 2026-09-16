const fs=require('fs'),path=require('path'),sharp=require('sharp');
const base='output/agent-animation-study/approved-motion';
async function bounds(p){const{data,info}=await sharp(p).ensureAlpha().raw().toBuffer({resolveWithObject:true});let l=info.width,r=-1,t=info.height,b=-1;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}return {left:l,top:t,width:r-l+1,height:b-t+1,bottom:b};}
(async()=>{const generated='C:/Users/andro/.codex/generated_images/01a09e2a-59d9-7333-ae0c-3d07653ddb14/';const rows=[];
for(const[id,dir,file]of [['plaguedoctor','west','exec-5b714125-122f-49f7-93a7-fb917e8bb29f.png'],['voidwizard','east','exec-a79616a0-356a-49c1-90c0-b14aeed4e765.png']]){
 const src=base+'/'+id+'/seat-clean-source.png';fs.copyFileSync(generated+file,src);const source=await bounds(src),old=await bounds(base+'/'+id+'/sit/'+dir+'/4.png');
 const crop=await sharp(src).extract({left:source.left,top:source.top,width:source.width,height:source.height}).resize({height:old.height}).png().toBuffer();const m=await sharp(crop).metadata();
 const dest='frontend/assets/agent-demo/approved-motion/'+id+'/sit_'+dir+'_4.png';await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((144-m.width)/2),top:24+old.bottom+1-m.height}]).png().toFile(dest);
 fs.copyFileSync(dest,'website/app/assets/agent-demo/approved-motion/'+id+'/sit_'+dir+'_4.png');rows.push({id,dir,source:file,height:m.height,width:m.width,foot:24+old.bottom+1});
}fs.writeFileSync(base+'/seat-cleanups.json',JSON.stringify(rows,null,2));console.log(rows);})();
