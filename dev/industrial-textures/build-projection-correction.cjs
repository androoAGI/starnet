'use strict';
const fs=require('node:fs'),sharp=require('sharp'),crypto=require('node:crypto');
const root='frontend/assets/industrial/projection-correction',old='frontend/assets/industrial/approved-sheet';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const items=[['quarters_pooltable',475,193,371,266],['tv',889,208,301,233],['arcade',142,539,163,352],['arcade2',496,539,160,348],['recliner_r',826,595,260,286],['recliner',1203,595,258,286],['couch'],['fishtank']];
const envelopes={couch:{x:-1,y:-10,width:62,height:22},quarters_pooltable:{x:-1,y:-11,width:50,height:35},tv:{x:-1,y:-12,width:38,height:24},fishtank:{x:-1,y:-12,width:26,height:24},arcade:{x:-1,y:-2,width:14,height:26},arcade2:{x:-1,y:-3,width:14,height:27},recliner:{x:-3,y:-7,width:17,height:19},recliner_r:{x:-2,y:-7,width:17,height:19}};
(async()=>{
 const manifest=JSON.parse(fs.readFileSync(old+'/manifest.json')),records=[];
 // Keep accepted anchors and untouched props byte-identical in this opt-in set.
 for(const p of Object.values(manifest.props))for(const v of Object.values(p.views))fs.copyFileSync(old+'/'+v.image,root+'/'+v.image);
 for(const [id,rx,ry,rw,rh]of items){
  const source=root+'/'+(rw?'lounge-source':id==='couch'?'couch-north-source':id==='fishtank'?'fishtank-balanced-source':id+'-source')+'.png',bytes=fs.readFileSync(source),s=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const left=rx||0,top=ry||0,w=rw||s.info.width,h=rh||s.info.height,raw=Buffer.alloc(w*h*4),core=new Uint8Array(w*h);let contactBottom=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=(y*w+x)*4,q=((y+top)*s.info.width+x+left)*4;s.data.copy(raw,d,q,q+4);if(raw[d+3]>=180){core[y*w+x]=1;contactBottom=Math.max(contactBottom,y);}}
  let l=w,t=h,r=-1,b=-1,retained=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=(y*w+x)*4;let keep=!!core[y*w+x];if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-3);yy<=Math.min(h-1,y+3)&&!keep;yy++)for(let xx=Math.max(0,x-3);xx<=Math.min(w-1,x+3);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=9){keep=true;break;}if(!keep){raw[d+3]=0;continue;}retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
  if(r<l)throw Error('Empty '+id);const width=r-l+1,height=b-t+1,png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract({left:l,top:t,width,height}).png().toBuffer(),image=id+'.png';fs.writeFileSync(root+'/'+image,png);
  const contact={x:.5,y:(contactBottom+1-t)/height};
  manifest.props[id].views.s={...manifest.props[id].views.s,image,sourceWidth:width,sourceHeight:height,bounds:envelopes[id],contact,effects:false};
  records.push({id,source,sourceSha256:hash(bytes),output:root+'/'+image,outputSha256:hash(png),sourceCrop:{left:left+l,top:top+t,width,height},retained,contact,bounds:envelopes[id],status:'projection candidate; requires in-station visual review'});
 }
 manifest.artSet='projection-correction-candidate';fs.writeFileSync(root+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync('docs/station-remaster/projection-correction/exports.json',JSON.stringify({version:1,records},null,2)+'\n');console.log(records.map(r=>({id:r.id,source:[r.sourceCrop.width,r.sourceCrop.height],bounds:r.bounds,contact:r.contact})));
})();
