'use strict';
// Non-destructive export of generated corrections; only transparent margins are cropped.
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const root='frontend/assets/industrial/camera-audit',docs='docs/station-remaster/camera-audit';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sourceRoot='C:/Users/andro/.codex/generated_images/01a09e45-c8db-79c2-b990-4349e09fba9c';
const jobs=[['workbench','2131b83e-6dd5-429f-a8a7-52d741fb6a6f','v2'],['longtable','dc7a85fc-3af7-4974-870e-5425661ecb1f'],['bridge_tacticaltable','3f5548d0-5cb9-441a-8618-0944b6800b9a','v2'],['toolbox','2f24db72-bcab-4816-aa73-968a110eb2f0']];
(async()=>{
fs.mkdirSync(root+'/sources',{recursive:true});fs.mkdirSync(docs,{recursive:true});
const m=JSON.parse(fs.readFileSync('frontend/assets/industrial/projection-correction/manifest.json')),records=[];
for(const[id,key,version]of jobs){
 const source=root+'/sources/'+id+(version?'-'+version:'')+'.png';if(!fs.existsSync(source))fs.copyFileSync(sourceRoot+'/exec-'+key+'.png',source);
 const bytes=fs.readFileSync(source),{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let left=info.width,top=info.height,right=-1,bottom=-1,foot=-1,retained=0;
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){const a=data[(y*info.width+x)*4+3];if(a>8){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);retained++;}if(a>=180)foot=Math.max(foot,y);}
 if(right<left||foot<0)throw Error('No opaque body: '+id);
 const width=right-left+1,height=bottom-top+1,crop={left,top,width,height};
 retained=0;for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(data[(y*info.width+x)*4+3]>0)retained++;
 const out=await sharp(bytes).extract(crop).png().toBuffer(),repoPath=root+'/'+id+'.png';fs.writeFileSync(repoPath,out);
 const old=m.props[id].views.s,record={id,view:'s',source,sourceSha256:hash(bytes),repoPath,outputSha256:hash(out),sourceCrop:crop,sourceWidth:width,sourceHeight:height,footprint:old.footprint,bounds:old.bounds,contact:{x:.5,y:(foot+1-top)/height},retained,status:'camera correction candidate; inspect in station'};
 if(id==='longtable')record.surfaceSupport={space:'export-normalized',points:[[.04,.06],[.96,.06],[.96,.74],[.04,.74]]};
 if(id==='toolbox')record.bounds={x:1,y:5,width:10,height:7};
 if(id==='workbench')record.exposure=1.35; // dark top stays legible against the tread deck under the shared light pass
 records.push(record);console.log(id,JSON.stringify(crop));
}
fs.writeFileSync(docs+'/integration.json',JSON.stringify({records},null,2)+'\n');
const gp='docs/station-remaster/projection-correction/catalog-groups.json',groups=JSON.parse(fs.readFileSync(gp));
if(!groups.groups.some(g=>g.name==='camera-audit'))groups.groups.push({name:'camera-audit',file:docs+'/integration.json'});
fs.writeFileSync(gp,JSON.stringify(groups,null,2)+'\n');
})();
