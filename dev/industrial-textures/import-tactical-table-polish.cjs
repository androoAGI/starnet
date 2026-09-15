'use strict';
// Crop transparent margins only. New machine bodies remain generated raster art.
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const root='frontend/assets/industrial/tactical-table-polish',docs='docs/station-remaster/tactical-table-polish';
const generated='C:/Users/andro/.codex/generated_images/01a09e45-c8db-79c2-b990-4349e09fba9c';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const jobs=[['bridge_tacticaltable','44ac680d-0b14-47d2-ac91-c7e575aad227','hex-thin-v5']];
(async()=>{
 fs.mkdirSync(root+'/sources',{recursive:true});fs.mkdirSync(root+'/before',{recursive:true});fs.mkdirSync(docs,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync('frontend/assets/industrial/projection-correction/manifest.json')),records=[];
 for(const[id,key,version]of jobs){
  const source=root+'/sources/'+id+(version?'-'+version:'')+'.png',before=root+'/before/'+id+'.png';
  if(!fs.existsSync(source))fs.copyFileSync(generated+'/exec-'+key+'.png',source);
  if(!fs.existsSync(before))fs.copyFileSync('frontend/assets/industrial/projection-correction/'+id+'.png',before);
  const bytes=fs.readFileSync(source),{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let left=info.width,top=info.height,right=-1,bottom=-1,foot=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){const a=data[(y*info.width+x)*4+3];if(a>8){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}if(a>=180)foot=Math.max(foot,y);}
  if(foot<0)throw Error('No opaque machine '+id);
  const crop={left,top,width:right-left+1,height:bottom-top+1};let retained=0;
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(data[(y*info.width+x)*4+3])retained++;
  const out=await sharp(bytes).extract(crop).png().toBuffer(),repoPath=root+'/'+id+'.png';fs.writeFileSync(repoPath,out);
  const old=manifest.props[id].views.s;
  // The former 84x55 display box made this bigger than two desks. Keep the
  // saved floor anchor, but author a compact 50x28 visual envelope beside them.
  records.push({id,view:'s',before,source,sourceSha256:hash(bytes),repoPath,outputSha256:hash(out),sourceCrop:crop,sourceWidth:crop.width,sourceHeight:crop.height,footprint:old.footprint,bounds:{x:17,y:20,width:50,height:28},exposure:1,contact:{x:.5,y:(foot+1-top)/crop.height},retained,status:'restored hexagonal style with thinner rim; owner review pending'});
  console.log(id,crop);
 }
 fs.writeFileSync(docs+'/integration.json',JSON.stringify({records},null,2)+'\n');
 const gp='docs/station-remaster/projection-correction/catalog-groups.json',groups=JSON.parse(fs.readFileSync(gp));
 if(!groups.groups.some(g=>g.name==='tactical-table-polish'))groups.groups.push({name:'tactical-table-polish',file:docs+'/integration.json'});
 fs.writeFileSync(gp,JSON.stringify(groups,null,2)+'\n');
})();
