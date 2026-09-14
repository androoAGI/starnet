'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),base='frontend/assets/industrial/batch03';
async function main(){
 const read=p=>JSON.parse(fs.readFileSync(path.join(root,p)));
 const original=read('frontend/assets/industrial/batch02/catalog.json'),claims=read('docs/station-remaster/batch03/claims.json'),structure=read('dev/industrial-textures/prop-structure-manifest.json').props,items=[];
 const candidates=original.items.map(a=>({...a,previousImage:a.image,kind:'repaint',section:a.lane}));
 for(const g of claims.newSections)for(const id of g.ids){const s=structure[id],v=s.views.s||Object.values(s.views)[0];candidates.push({id,label:s.label,lane:g.lane,group:g.label,section:g.section,kind:'new',bounds:v.bounds,previousImage:null});}
 for(const a of candidates){const lane=[a.lane,'coordinator','storage','crew','utility','habitat','control'].find(l=>fs.existsSync(path.join(root,base,l,a.id+'.png')));if(!lane)continue;
  const file=path.join(root,base,lane,a.id+'.png'),{data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});let transparent=0,opaque=0;
  for(let i=3;i<data.length;i+=4){if(!data[i])transparent++;if(data[i]===255)opaque++;}if(!transparent||!opaque)throw Error('Missing alpha/body '+a.id);
  const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const facings=fs.readdirSync(path.join(root,base,lane)).filter(f=>f.startsWith(a.id+'-r')&&f.endsWith('.png')).map(f=>'assets/industrial/batch03/'+lane+'/'+f);
  items.push({...a,image:'assets/industrial/batch03/'+lane+'/'+a.id+'.png?v='+hash.slice(0,12),facings,width:info.width,height:info.height,transparentPixels:transparent,opaquePixels:opaque,status:'illustrated-style-candidate'});
 }
 const repainted=items.filter(a=>a.kind==='repaint').length,newDesigns=items.length-repainted;
 fs.writeFileSync(path.join(root,base,'catalog.json'),JSON.stringify({planned:original.planned,repainted,newDesigns,exported:items.length,sections:claims.newSections.map(g=>({id:g.section,label:g.label})),items},null,2)+'\n');console.log(repainted+' repaints + '+newDesigns+' new designs alpha-checked');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

