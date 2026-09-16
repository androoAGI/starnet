'use strict';
// Generated restoration export: preserve source RGBA; crop transparent margins only.
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const root='frontend/assets/industrial/sharpness-restoration',docs='docs/station-remaster/sharpness-restoration';
const generated='C:/Users/andro/.codex/generated_images/01a09e45-c8db-79c2-b990-4349e09fba9c';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const jobs=[
 ['desk','s','80a0277b-b049-4140-9771-580a48ef56db','desk',0,0,1,1],
 ['crate','s','ae8be8ee-761b-4df9-b3ed-7f0141cd2392','anchors',0,0,2,1],
 ['chair','s','ae8be8ee-761b-4df9-b3ed-7f0141cd2392','anchors',1,0,2,1],
 ['industrial_partition','w','64e2c3f0-1de4-496d-990f-8df5f99dc119','remaining',0,0,2,2],
 ['desk','n','64e2c3f0-1de4-496d-990f-8df5f99dc119','remaining',1,0,2,2],
 ['rug_large','s','64e2c3f0-1de4-496d-990f-8df5f99dc119','remaining',1,1,2,2],
 ['bridge_deckperimeter','s','8f2a88c9-b124-4564-98f2-fcf46f5083ae','perimeter',0,0,1,1]
];
(async()=>{
 fs.mkdirSync(root+'/sources',{recursive:true});fs.mkdirSync(root+'/before',{recursive:true});fs.mkdirSync(docs,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync('frontend/assets/industrial/projection-correction/manifest.json')),records=[];
 for(const[id,view,key,name,col,row,cols,rows]of jobs){
  const image=id+(view==='s'?'':'-'+view)+'.png',before=root+'/before/'+image;
  if(!fs.existsSync(before))fs.copyFileSync('frontend/assets/industrial/'+(['desk:s','crate:s','chair:s'].includes(id+':'+view)?'approved-sheet/':'projection-correction/')+image,before);
  const source=root+'/sources/'+name+'.png';
  if(!fs.existsSync(source))fs.copyFileSync(generated+'/exec-'+key+'.png',source);
  const bytes=fs.readFileSync(source),{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const start=Math.floor(col*info.width/cols),end=Math.floor((col+1)*info.width/cols),startY=Math.floor(row*info.height/rows),endY=Math.floor((row+1)*info.height/rows);
  let left=end,top=info.height,right=-1,bottom=-1,foot=-1;
  for(let y=startY;y<endY;y++)for(let x=start;x<end;x++){
   const a=data[(y*info.width+x)*4+3];if(a>8){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}if(a>=180)foot=Math.max(foot,y);
  }
  if(foot<0)throw Error('No body: '+id);
  const crop={left,top,width:right-left+1,height:bottom-top+1};
  let retained=0;for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(data[(y*info.width+x)*4+3])retained++;
  const out=await sharp(bytes).extract(crop).png().toBuffer(),repoPath=root+'/'+image;fs.writeFileSync(repoPath,out);
  const old=manifest.props[id].views[view];
  records.push({id,view,before,source,sourceSha256:hash(bytes),repoPath,outputSha256:hash(out),sourceCrop:crop,sourceWidth:crop.width,sourceHeight:crop.height,footprint:old.footprint,bounds:old.bounds,contact:{x:.5,y:(foot+1-top)/crop.height},retained,status:'resolution restoration; original design and world bounds retained; owner review pending'});
  console.log(id,crop.width+'x'+crop.height);
 }
 fs.writeFileSync(docs+'/integration.json',JSON.stringify({records},null,2)+'\n');
 const gp='docs/station-remaster/projection-correction/catalog-groups.json',groups=JSON.parse(fs.readFileSync(gp));
 if(!groups.groups.some(g=>g.name==='sharpness-restoration'))groups.groups.push({name:'sharpness-restoration',file:docs+'/integration.json'});
 fs.writeFileSync(gp,JSON.stringify(groups,null,2)+'\n');
})();
