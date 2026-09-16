'use strict';
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const root='frontend/assets/industrial/projection-correction',old='frontend/assets/industrial/approved-sheet';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const items=[['quarters_pooltable',475,193,371,266],['tv',889,208,301,233],['arcade',142,539,163,352],['arcade2',496,539,160,348],['recliner_r',826,595,260,286],['recliner',1203,595,258,286],['couch'],['fishtank']];
const envelopes={couch:{x:-1,y:-14,width:62,height:26},quarters_pooltable:{x:-1,y:-11,width:50,height:35},tv:{x:-1,y:-12,width:38,height:24},fishtank:{x:-1,y:-12,width:26,height:24},arcade:{x:-1,y:-2,width:14,height:26},arcade2:{x:-1,y:-3,width:14,height:27},recliner:{x:-3,y:-7,width:17,height:19},recliner_r:{x:-2,y:-7,width:17,height:19}};
(async()=>{
 const manifest=JSON.parse(fs.readFileSync(old+'/manifest.json')),records=[];
 // Keep accepted anchors and untouched props byte-identical in this opt-in set.
 for(const p of Object.values(manifest.props))for(const v of Object.values(p.views))fs.copyFileSync(old+'/'+v.image,root+'/'+v.image);
 for(const [id,rx,ry,rw,rh]of items){
  const source=root+'/'+(rw?'lounge-source':id==='couch'?'couch-angle-source':id==='fishtank'?'fishtank-balanced-source':id+'-source')+'.png',bytes=fs.readFileSync(source),s=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const left=rx||0,top=ry||0,w=rw||s.info.width,h=rh||s.info.height,raw=Buffer.alloc(w*h*4),core=new Uint8Array(w*h);let contactBottom=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=(y*w+x)*4,q=((y+top)*s.info.width+x+left)*4;s.data.copy(raw,d,q,q+4);if(raw[d+3]>=180){core[y*w+x]=1;contactBottom=Math.max(contactBottom,y);}}
  let l=w,t=h,r=-1,b=-1,retained=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=(y*w+x)*4;let keep=!!core[y*w+x];if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-3);yy<=Math.min(h-1,y+3)&&!keep;yy++)for(let xx=Math.max(0,x-3);xx<=Math.min(w-1,x+3);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=9){keep=true;break;}if(!keep){raw[d+3]=0;continue;}retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
  if(r<l)throw Error('Empty '+id);const width=r-l+1,height=b-t+1,png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract({left:l,top:t,width,height}).png().toBuffer(),image=id+'.png';fs.writeFileSync(root+'/'+image,png);
  const contact={x:.5,y:(contactBottom+1-t)/height};
  manifest.props[id].views.s={...manifest.props[id].views.s,image,sourceWidth:width,sourceHeight:height,bounds:envelopes[id],contact,effects:false};
  records.push({id,source,sourceSha256:hash(bytes),output:root+'/'+image,outputSha256:hash(png),sourceCrop:{left:left+l,top:top+t,width,height},retained,contact,bounds:envelopes[id],status:'projection candidate; requires in-station visual review'});
 }
 const groupFile='docs/station-remaster/projection-correction/catalog-groups.json';
 for(const group of fs.existsSync(groupFile)?JSON.parse(fs.readFileSync(groupFile)).groups:[]){
  for(const r of JSON.parse(fs.readFileSync(group.file)).records){
   if((group.exclude||[]).includes(r.id))continue;
   const face=r.view||'s',previous=manifest.props[r.id]?.views[face];if(!previous)throw Error('Unknown catalog view '+r.id+':'+face);
   const compactTable=r.id==='bridge_tacticaltable'&&face==='s'&&r.footprint.w===5&&r.footprint.h===3;
   if(!compactTable&&JSON.stringify(previous.footprint)!==JSON.stringify(r.footprint))throw Error('Footprint changed '+r.id);
   const from=r.repoPath||r.output||r.image,bytes=fs.readFileSync(from),image=r.id+(face==='s'?'':'-'+face)+'.png';
   if(hash(bytes)!==r.outputSha256)throw Error('Export receipt mismatch '+r.id);
   const meta=await sharp(bytes).metadata();if(meta.width!==r.sourceWidth||meta.height!==r.sourceHeight)throw Error('Dimensions mismatch '+r.id);
   fs.copyFileSync(from,root+'/'+image);
   const next={...previous,footprint:r.footprint,image,sourceWidth:r.sourceWidth,sourceHeight:r.sourceHeight,bounds:r.bounds,contact:{x:r.contact.x??.5,y:r.contact.y},effects:false};
   if(r.exposure!=null)next.exposure=r.exposure;
   if(r.surfaceSupport)next.surfaceSupport=r.surfaceSupport;else if(previous.surfaceSupport)throw Error('Changed table requires new surface points '+r.id+':'+face);
   manifest.props[r.id].views[face]=next;
   const prior=records.findIndex(v=>v.id===r.id&&(v.view||'s')===face);
   if(prior>=0)records.splice(prior,1); // a later correction replaces a view; it is not extra coverage
   records.push({...r,view:face,group:group.name,source:r.source,output:root+'/'+image,retained:r.retained??r.retainedPixels??r.verification?.retained??(r.alphaCounts.partial+r.alphaCounts.opaque),contact:next.contact,bounds:next.bounds});
  }
 }
 require('./projection-display-fit.cjs').apply(manifest,records);
 manifest.artSet='projection-correction-candidate';manifest.revisedViews=records.map(r=>({id:r.id,view:r.view||'s',group:r.group||'lounge'}));fs.writeFileSync(root+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync('docs/station-remaster/projection-correction/exports.json',JSON.stringify({version:1,records},null,2)+'\n');
 const revisedProps=[...new Set(records.map(r=>r.id))].sort(),unchangedAcceptedProps=['crate','desk','chair'].filter(id=>!records.some(r=>r.id===id&&(r.view||'s')==='s'));
 fs.writeFileSync('docs/station-remaster/projection-correction/coverage.json',JSON.stringify({status:'candidate; visual owner acceptance separate',totalProps:Object.keys(manifest.props).length,revisedViewCount:records.length,revisedProps,unchangedAcceptedProps,remainingProps:Object.keys(manifest.props).filter(id=>!revisedProps.includes(id)&&!unchangedAcceptedProps.includes(id)).sort()},null,2)+'\n');
 console.log('Built '+records.length+' corrected views across '+revisedProps.length+' props.');
})();
