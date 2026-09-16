'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp'),crypto=require('node:crypto');
(async()=>{
 const source=process.argv[2];if(!source)throw Error('Supply the skin study asset directory');
 const target='frontend/assets/skin-study-0914';fs.mkdirSync(target,{recursive:true});
 const skins=[];
 for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  if(!entry.isDirectory()){if(/\.(json|md)$/.test(entry.name))fs.copyFileSync(path.join(source,entry.name),path.join(target,entry.name));continue;}
  const id=entry.name,views={};let height=0;
  for(const dir of ['south','east','north','west']){
   const bytes=fs.readFileSync(path.join(source,id,dir+'.png'));const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   let top=info.height,bottom=-1;
   for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>16){top=Math.min(top,y);bottom=Math.max(bottom,y);}
   if(bottom<top)throw Error('Empty '+id+':'+dir);height=Math.max(height,bottom-top+1);
   fs.mkdirSync(path.join(target,id),{recursive:true});fs.writeFileSync(path.join(target,id,dir+'.png'),bytes);
   views[dir]={width:info.width,height:info.height,top,bottom,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  }
  skins.push({id,scale:(id==='ultron'?25:18)/height,views});
 }
 fs.writeFileSync(path.join(target,'runtime-preview.json'),JSON.stringify({status:'Four standing directions only; no walk or seated animation',skins},null,2)+'\n');
 console.log('Copied '+skins.length+' skins / '+skins.length*4+' unchanged PNGs');
})();
