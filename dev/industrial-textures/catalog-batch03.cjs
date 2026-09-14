'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),base='frontend/assets/industrial/batch03';
async function main(){const original=JSON.parse(fs.readFileSync(path.join(root,'frontend/assets/industrial/batch02/catalog.json'))),items=[];
 for(const a of original.items){const lane=[a.lane,'coordinator','storage','crew','utility'].find(l=>fs.existsSync(path.join(root,base,l,a.id+'.png')));if(!lane)continue;
 const rel=base+'/'+lane+'/'+a.id+'.png',file=path.join(root,rel),{data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});let transparent=0,opaque=0;
 for(let i=3;i<data.length;i+=4){if(!data[i])transparent++;if(data[i]===255)opaque++;}if(!transparent||!opaque)throw Error('Missing alpha/body '+a.id);
 const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 items.push({...a,previousImage:a.image,image:'assets/industrial/batch03/'+lane+'/'+a.id+'.png?v='+hash.slice(0,12),width:info.width,height:info.height,transparentPixels:transparent,opaquePixels:opaque,status:'illustrated-style-candidate'});
 }
 fs.mkdirSync(path.join(root,base),{recursive:true});fs.writeFileSync(path.join(root,base,'catalog.json'),JSON.stringify({planned:original.planned,exported:items.length,items},null,2)+'\n');console.log(items.length+'/'+original.planned+' illustrated replacements alpha-checked');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
