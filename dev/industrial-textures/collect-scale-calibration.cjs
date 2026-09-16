'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp'),crypto=require('node:crypto');
const owner=process.argv[2]||'C:/Users/andro/gen-trees/industrial-textures-0912';
const dest='frontend/assets/industrial/scale-calibration',docs='docs/station-remaster/scale-calibration';
const candidates=[['couch','coordinator/couch.png',62,24],['couch-alt','crew/couch-alt.png',62,24],['desk','coordinator/desk.png',38,24],['bookshelf','storage/bookshelf.png',26,22],['coffee','utility/coffee.png',13,18],['monstera','utility/monstera.png',12,13]];
const manifest=JSON.parse(fs.readFileSync(path.join(owner,'frontend/assets/industrial/props-v3/manifest.json')));
async function measure(file){const bytes=fs.readFileSync(file),r=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});let l=r.info.width,t=r.info.height,right=-1,b=-1;for(let i=3;i<r.data.length;i+=4)if(r.data[i]){const n=(i-3)/4,x=n%r.info.width,y=Math.floor(n/r.info.width);l=Math.min(l,x);t=Math.min(t,y);right=Math.max(right,x);b=Math.max(b,y);}return{width:r.info.width,height:r.info.height,crop:{x:l,y:t,width:right-l+1,height:b-t+1},sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
(async()=>{fs.mkdirSync(dest+'/before',{recursive:true});fs.mkdirSync(dest+'/references',{recursive:true});const refs=[['fwefwg.JPG','reference-small.jpg'],['Futuristic weapon armory interior design.png','reference-armory.png'],['bridge (1).png','reference-bridge.png']];for(const [source,name]of refs)fs.copyFileSync('C:/Users/andro/Downloads/'+source,dest+'/references/'+name);
const items=[];for(const [id,image,width,height]of candidates){const file=dest+'/'+image;if(!fs.existsSync(file))continue;const originalId=id==='couch-alt'?'couch':id;
const spec=manifest.props[originalId]?.views.s;
const original=originalId==='desk'?path.join(owner,'frontend/assets/industrial/workstation.png'):path.join(owner,'frontend/assets/industrial/props-v3',spec.image);
fs.copyFileSync(original,dest+'/before/'+id+'.png');const current=await measure(dest+'/before/'+id+'.png'),next=await measure(file);
const bounds=spec?.bounds||{x:-1,y:-11.5,width:38,height:23.5};
const make=(m,b)=>{const scale=Math.min(b.width/m.crop.width,b.height/m.crop.height);return{...m,bounds:b,fit:{width:m.crop.width*scale,height:m.crop.height*scale}};};
items.push({id,originalId,current:{image:'assets/industrial/scale-calibration/before/'+id+'.png',...make(current,bounds),exposure:spec?.exposure||1.5},candidate:{image:'assets/industrial/scale-calibration/'+image,...make(next,{x:bounds.x,y:12-height,width,height}),exposure:1},status:'Calibration candidate; not accepted or runtime integrated'});
}
fs.writeFileSync(docs+'/catalog.json',JSON.stringify({version:1,styleReferences:refs.map(r=>'assets/industrial/scale-calibration/references/'+r[1]),items},null,2)+'\n');console.log(JSON.stringify(items.map(i=>({id:i.id,before:i.current.fit,after:i.candidate.fit}))));})();
