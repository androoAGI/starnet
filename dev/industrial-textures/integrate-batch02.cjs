'use strict';
// Full replacement art only. The source/export lanes remain the provenance;
// this file owns world calibration and new runtime motion/foreground regions.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p);
const structure=JSON.parse(fs.readFileSync(at('dev/industrial-textures/prop-structure-manifest.json')));
const runtime='frontend/assets/industrial/props-v3/',manifest=JSON.parse(fs.readFileSync(at(runtime+'manifest.json')));
const select={
 storage:'bookshelf bookstack mug guitar radio figurine modelship toolbox desklamp research_papers etsy_threadrack easel'.split(' '),
 crew:'bar bunk quarters_pooltable pokertable beanbag industrial_bench sidetable coffee quarters_minifridge quarters_vending'.split(' '),
 utility:'industrial_planter tallplant monstera'.split(' '),
 coordinator:'whiteboard chartwall arc_indexwall'.split(' ')
};
const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const pulse=(region,colour,trigger='work')=>({mode:'pulse',motion:{region,colour,trigger}});
const overrides={
 bookshelf:{bounds:{x:-1,y:-10,width:26,height:22}},
 mug:{bounds:{x:4,y:8,width:4,height:4},mode:'steam',motion:{origin:[.36,.3],rise:2,trigger:'ambient'}},
 radio:pulse(rect(.63,.35,.24,.17),[205,158,85],'ambient'),
 modelship:pulse(rect(.87,.23,.1,.22),[187,132,67],'ambient'),
 bar:pulse(rect(.03,.49,.94,.035),[181,125,62]),
 bunk:{foreground:[[0,.269],[1,.269],[1,1],[0,1]]},
 quarters_pooltable:{mode:'pool',motion:{region:rect(.105,.12,.765,.465)}},
 coffee:{mode:'steam',motion:{origin:[.49,.65],rise:2.4,trigger:'work'}},
 quarters_minifridge:pulse(rect(.765,.237,.065,.04),[218,202,158]),
 quarters_vending:pulse(rect(.235,.179,.41,.011),[222,175,92])
};
(async()=>{
 const adopted=[];
 for(const [lane,ids]of Object.entries(select))for(const id of ids){
  const file=id==='quarters_pooltable'?'pooltable-clean.png':id+'.png',from='frontend/assets/industrial/batch02/'+lane+'/'+file;
  if(!fs.existsSync(at(from)))throw Error('Missing complete artwork '+id);
  const info=await sharp(at(from)).metadata(),geometry=structure.props[id].views.s;
  const v={image:id+'.png',sourceWidth:info.width,sourceHeight:info.height,footprint:geometry.footprint,bounds:geometry.bounds,exposure:1,mode:'static',...overrides[id]};
  fs.copyFileSync(at(from),at(runtime+v.image));manifest.props[id]={views:{s:v}};adopted.push(id);
 }
 fs.writeFileSync(at(runtime+'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const p=at('docs/station-remaster/props-v3/coverage.json'),ledger=JSON.parse(fs.readFileSync(p));
 for(const row of ledger.props)if(manifest.props[row.id])Object.assign(row,{status:'new-design-awaiting-review',views:Object.keys(manifest.props[row.id].views)});
 ledger.newDesigns=ledger.props.filter(p=>p.status==='new-design-awaiting-review').length;
 ledger.remainingFullRedesign=ledger.catalog-ledger.approved-ledger.newDesigns;
 fs.writeFileSync(p,JSON.stringify(ledger,null,2)+'\n');console.log(JSON.stringify({adopted,newDesigns:ledger.newDesigns,approved:ledger.approved}));
})().catch(e=>{console.error(e);process.exitCode=1;});
