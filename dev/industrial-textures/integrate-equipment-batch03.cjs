'use strict';
// New equipment bodies and coordinated painted-style corrections.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p);
const structure=require('./prop-structure-manifest.json');
const runtime='frontend/assets/industrial/props-v3/',mp=at(runtime+'manifest.json'),manifest=JSON.parse(fs.readFileSync(mp));
const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const pulse=(region,colour,trigger='work',failureColour)=>({mode:'pulse',motion:{region,colour,trigger,...(failureColour?{failureColour}:{})}});
const specs={
 pixelrig:{mode:'screen',screenRegions:[rect(.224,.116,.341,.247),rect(.661,.474,.16,.105)]},
 bench:{mode:'screen',screenRegions:[rect(.297,.083,.17,.252),rect(.535,.083,.17,.252),rect(.292,.446,.046,.095)]},
 workbench:pulse(rect(.357,.597,.275,.028),[90,218,155],'fired',[239,75,63]),
 rack:pulse(rect(.786,.306,.067,.021),[196,150,68]),
 rackV:pulse(rect(.646,.216,.027,.009),[111,193,194]),
 core:pulse(rect(.213,.258,.585,.525),[156,115,204])
};
const corrections={bookshelf:'storage',industrial_bench:'crew',monstera:'utility',coffee:'coordinator'};
(async()=>{
 for(const id of [...Object.keys(specs),...Object.keys(corrections)]){
  const lane=corrections[id]||'equipment',from=at('frontend/assets/industrial/batch03/'+lane+'/'+id+'.png');
  const meta=await sharp(from).metadata(),g=structure.props[id].views.s;
  const old=manifest.props[id]&&manifest.props[id].views.s;
  const v={image:id+'.png',sourceWidth:meta.width,sourceHeight:meta.height,footprint:g.footprint,bounds:g.bounds,exposure:1,mode:'static',...(old||{}),...(specs[id]||{})};
  v.sourceWidth=meta.width;v.sourceHeight=meta.height;
  if(id==='coffee')v.motion={origin:[.46,.68],rise:2.4,trigger:'work'};
  fs.copyFileSync(from,at(runtime+id+'.png'));manifest.props[id]={views:{s:v}};
 }
 fs.writeFileSync(mp,JSON.stringify(manifest,null,2)+'\n');
 const cp=at('docs/station-remaster/props-v3/coverage.json'),coverage=JSON.parse(fs.readFileSync(cp));
 for(const row of coverage.props)if(manifest.props[row.id])Object.assign(row,{status:'new-design-awaiting-review',views:Object.keys(manifest.props[row.id].views)});
 coverage.newDesigns=coverage.props.filter(p=>p.status==='new-design-awaiting-review').length;
 coverage.remainingFullRedesign=coverage.catalog-coverage.approved-coverage.newDesigns;
 fs.writeFileSync(cp,JSON.stringify(coverage,null,2)+'\n');
 console.log(JSON.stringify({newEquipment:Object.keys(specs),styleCorrections:Object.keys(corrections),newDesigns:coverage.newDesigns}));
})().catch(e=>{console.error(e);process.exitCode=1;});
