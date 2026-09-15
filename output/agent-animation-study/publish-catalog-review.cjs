const fs=require('fs');
const base='output/agent-animation-study/rollout-20px',catalog=JSON.parse(fs.readFileSync(base+'/catalog.json')),manifest=JSON.parse(fs.readFileSync('frontend/agent-demo/manifest.json'));
const dirs=['south','south-east','east','north-east','north','north-west','west','south-west'];
const retained=JSON.parse(fs.readFileSync(base+'/blocked-redesigns.json'));
for(const item of catalog.skins){const key='approved_'+item.id;const reviewPath=base+'/full-motion/'+item.id+'/review.json';const approved=['ultron','skeleton','plaguedoctor','secretagent','voidwizard'].includes(item.id)||(fs.existsSync(reviewPath)&&JSON.parse(fs.readFileSync(reviewPath)).walkApproved);item.walkFramesReady=dirs.every(d=>manifest.sprites[key+'.rot.'+d]?.length&&manifest.sprites[key+'.walk.'+d]?.length===8);item.walkReady=!!approved&&item.walkFramesReady;const seatsApproved=['ultron','skeleton','plaguedoctor','secretagent','voidwizard'].includes(item.id)||(fs.existsSync(reviewPath)&&JSON.parse(fs.readFileSync(reviewPath)).seatsApproved);item.complete=item.walkReady&&!!seatsApproved&&['south','east','north','west'].every(d=>manifest.sprites[key+'.sit.'+d]?.length)&&!!manifest.sprites[key+'.type.north']?.length;item.targetStandingHeight=19;
 const original=retained.find(x=>x.id===item.id);item.retainedOriginal=!!original;item.sourceStandingHeight=original?.sourceStandingHeight||76;item.readyForStation=item.walkReady||item.retainedOriginal;item.renderSet=item.retainedOriginal?item.skin:key;
 if(item.walkReady)for(const root of ['frontend','website/app']){const p=root+'/assets/sprites/manifest.json',m=JSON.parse(fs.readFileSync(p)),dir=root+'/assets/sprites/'+key;fs.mkdirSync(dir,{recursive:true});fs.copyFileSync('frontend/assets/agent-demo/approved-motion/'+item.id+'/rot_south.png',dir+'/rot_south.png');m.sprites[key+'.rot.south']=[key+'/rot_south.png'];fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');}
}
catalog.standingHeight=19;
for(const root of ['frontend','website/app'])fs.writeFileSync(root+'/agent-demo/catalog.json',JSON.stringify(catalog,null,2)+'\n');
console.log(catalog.skins.filter(x=>x.walkReady).map(x=>x.id));
