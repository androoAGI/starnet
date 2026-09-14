'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),base='frontend/assets/industrial/batch02';
const assigned={storage:'bookshelf bookstack mug guitar radio figurine modelship toolbox desklamp research_papers etsy_threadrack easel'.split(' '),crew:'bar bunk quarters_pooltable pokertable beanbag stool industrial_bench industrial_roundtable sidetable coffee quarters_minifridge quarters_vending'.split(' '),utility:'industrial_planter tallplant monstera terrarium fishtank lavalamp plasmaglobe etsy_dyevat etsy_kiln research_samplecart incubator cryopod'.split(' '),coordinator:'whiteboard chartwall calwall missionboard trophycase arc_indexwall arc_microfiche comms_inbox'.split(' ')};
const labels={storage:'Accessories & wood',crew:'Crew furniture',utility:'Plants, glass & lab',coordinator:'Boards & archive'};
async function main(){
 const structure=JSON.parse(fs.readFileSync(path.join(root,'dev/industrial-textures/prop-structure-manifest.json'))),items=[];
 for(const [lane,ids]of Object.entries(assigned))for(const id of ids){
  const name=id==='quarters_pooltable'&&fs.existsSync(path.join(root,base,lane,'pooltable-clean.png'))?'pooltable-clean':id;
  const rel=base+'/'+lane+'/'+name+'.png',file=path.join(root,rel);if(!fs.existsSync(file))continue;
  const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});let transparent=0,opaque=0;
  for(let i=3;i<data.length;i+=4){if(!data[i])transparent++;if(data[i]===255)opaque++;}
  if(!transparent||!opaque)throw Error('No genuine alpha or opaque body '+id);
  const prop=structure.props[id],v=prop.views.s;
  const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  items.push({id,lane,group:labels[lane],label:prop.label,image:'assets/industrial/batch02/'+lane+'/'+name+'.png?v='+hash.slice(0,12),width:info.width,height:info.height,footprint:v.footprint,bounds:v.bounds,transparentPixels:transparent,opaquePixels:opaque,status:'exported-art-awaiting-live-review'});
 }
 const out={version:1,planned:44,exported:items.length,generatedAt:new Date().toISOString(),note:'Artwork exports are separate from user acceptance and live runtime integration.',items};
 fs.mkdirSync(path.join(root,base),{recursive:true});fs.writeFileSync(path.join(root,base,'catalog.json'),JSON.stringify(out,null,2)+'\n');console.log(items.length+'/44 exported, alpha-checked');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
