'use strict';
// Import generated art without changing retained RGBA pixels or native footprints.
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const root='frontend/assets/industrial/capability-v2',docs='docs/station-remaster/capability-v2';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 fs.mkdirSync(root+'/sources',{recursive:true});fs.mkdirSync(root+'/before',{recursive:true});
 const manifest=JSON.parse(fs.readFileSync('frontend/assets/industrial/projection-correction/manifest.json'));
 const jobs=JSON.parse(fs.readFileSync(docs+'/sources.json')),records=[];
 for(const {id,source:generated}of jobs){
  const source=root+'/sources/'+id+'.png',before=root+'/before/'+id+'.png',repoPath=root+'/'+id+'.png';
  if(!fs.existsSync(source))fs.copyFileSync(generated,source);
  if(!fs.existsSync(before))fs.copyFileSync('frontend/assets/industrial/projection-correction/'+id+'.png',before);
  const bytes=fs.readFileSync(source),{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let l=info.width,t=info.height,r=-1,b=-1,foot=-1,transparent=0,retained=0;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
   const a=data[(y*info.width+x)*4+3];if(!a)transparent++;
   if(a>8){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);retained++;}
   if(a>=180)foot=Math.max(foot,y);
  }
  if(transparent<info.width*info.height*.02||foot<0)throw Error('Missing genuine alpha '+id);
  const sourceCrop={left:l,top:t,width:r-l+1,height:b-t+1};
  const output=await sharp(bytes).extract(sourceCrop).png().toBuffer();fs.writeFileSync(repoPath,output);
  const v=manifest.props[id].views.s;
  const decoded=await sharp(output).ensureAlpha().raw().toBuffer();let mismatches=0;retained=0;
  for(let i=3;i<decoded.length;i+=4)if(decoded[i])retained++;
  for(let y=0;y<sourceCrop.height;y++)for(let x=0;x<sourceCrop.width;x++)for(let c=0;c<4;c++)if(decoded[(y*sourceCrop.width+x)*4+c]!==data[((y+t)*info.width+x+l)*4+c])mismatches++;
  if(mismatches)throw Error('RGBA changed '+id);
  const fit=Math.min(v.bounds.width/sourceCrop.width,v.bounds.height/sourceCrop.height);
  records.push({id,view:'s',source,before,sourceSha256:hash(bytes),repoPath,outputSha256:hash(output),sourceCrop,sourceWidth:sourceCrop.width,sourceHeight:sourceCrop.height,footprint:v.footprint,bounds:v.bounds,exposure:1,contact:{x:.5,y:(foot+1-t)/sourceCrop.height},retained,verification:{genuineAlpha:true,rgbaMismatches:mismatches,worldSize:[+(sourceCrop.width*fit).toFixed(2),+(sourceCrop.height*fit).toFixed(2)],pixelsPerWorldPixel:+(1/fit).toFixed(2)},status:'generated redesign; live review pending'});
 }
 fs.writeFileSync(docs+'/integration.json',JSON.stringify({records},null,2)+'\n');
 const gp='docs/station-remaster/projection-correction/catalog-groups.json',groups=JSON.parse(fs.readFileSync(gp));
 groups.groups=groups.groups.filter(g=>g.name!=='capability-v2');groups.groups.push({name:'capability-v2',file:docs+'/integration.json'});fs.writeFileSync(gp,JSON.stringify(groups,null,2)+'\n');
 console.log(records.map(r=>({id:r.id,pixels:[r.sourceWidth,r.sourceHeight],world:r.verification.worldSize,alpha:r.verification.genuineAlpha})));
})().catch(e=>{console.error(e);process.exitCode=1;});

