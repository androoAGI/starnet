'use strict';
// Adopt complete authored assets; all original sources and export receipts stay
// in parallel-0914. This selects no casing-only drafts or metallic bookshelf.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p);
const source='frontend/assets/industrial/parallel-0914/exports/';
const target='frontend/assets/industrial/props-v3/';
const handoff=JSON.parse(fs.readFileSync(at(source+'handoff-manifest.json')));
const manifest=JSON.parse(fs.readFileSync(at(target+'manifest.json')));
const ids=['boxes','couch','lowtable','filter','tank'];
for(const id of ids){
 const views={};
 for(const [key,p]of Object.entries(handoff.props[id].views)){
  const v={image:p.image,sourceWidth:p.sourceWidth,sourceHeight:p.sourceHeight,footprint:p.footprint,bounds:p.bounds,exposure:1.1,mode:'static'};
  if(id==='filter')Object.assign(v,{mode:'scanner',motion:{region:[[.414,.23],[.58,.23],[.58,.268],[.414,.268]]}});
  if(id==='tank')Object.assign(v,{bounds:{x:-1.5,y:-12,width:27,height:24},mode:'water',motion:{region:[[.11,.62],[.75,.62],[.76,.70],[.68,.73],[.17,.73],[.11,.69]],bubbleLanes:[{x:.16,y:.45,width:.09,height:.18},{x:.60,y:.46,width:.09,height:.17}]}});
  fs.copyFileSync(at(source+p.image),at(target+p.image));views[key]=v;
 }
 manifest.props[id]={views};
}
fs.writeFileSync(at(target+'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const ledgerPath=at('docs/station-remaster/props-v3/coverage.json'),ledger=JSON.parse(fs.readFileSync(ledgerPath));
for(const p of ledger.props)if(manifest.props[p.id])Object.assign(p,{status:'new-design-awaiting-review',views:Object.keys(manifest.props[p.id].views)});
ledger.newDesigns=ledger.props.filter(p=>p.status==='new-design-awaiting-review').length;
ledger.remainingFullRedesign=ledger.catalog-ledger.approved-ledger.newDesigns;
fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
console.log(JSON.stringify({integrated:ids,newDesigns:ledger.newDesigns,approved:ledger.approved}));
