'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p),structure=require('./prop-structure-manifest.json');
const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const pulse=(region,colour,trigger='work')=>({mode:'pulse',motion:{region,colour,trigger}});
const specs={
 comms_dish:pulse(rect(.801,.80,.047,.037),[95,220,211]),
 comms_uplink:pulse(rect(.462,.102,.07,.014),[224,62,44],'ambient'),
 comms_beacon:pulse([[.168,.33],[.48,.37],[.81,.33],[.81,.62],[.50,.675],[.17,.62]],[134,222,231],'ambient'),
 commswall:{mode:'screen',screenRegions:[rect(.291,.26,.426,.546)]},
 bridge_relaystack:pulse(rect(.461,.895,.075,.014),[174,130,211]),
 war_intelcab:pulse(rect(.812,.249,.05,.572),[154,214,118]),
 fabricator:{mode:'machine'},tube:{mode:'machine'},etsy_packbot:{mode:'machine'},
 vat:pulse([[.228,.11],[.443,.056],[.78,.07],[.913,.134],[.91,.224],[.76,.285],[.446,.283],[.23,.224]],[211,158,56]),
 research_corelens:{mode:'screen'},
 research_trendpillar:{mode:'screen',screenRegions:[rect(.239,.172,.523,.374)]}
};
(async()=>{
 const dir='frontend/assets/industrial/props-v3/',mp=at(dir+'manifest.json'),manifest=JSON.parse(fs.readFileSync(mp));
 for(const [id,config]of Object.entries(specs)){
  const lane=id.startsWith('comms')||id==='bridge_relaystack'||id==='war_intelcab'?'communications':'lab';
  const source='frontend/assets/industrial/batch03/'+lane+'/'+id+'.png',meta=await sharp(at(source)).metadata(),geometry=structure.props[id].views.s;
  fs.copyFileSync(at(source),at(dir+id+'.png'));manifest.props[id]={views:{s:{image:id+'.png',sourceWidth:meta.width,sourceHeight:meta.height,footprint:geometry.footprint,bounds:geometry.bounds,exposure:1,...config}}};
 }
 fs.copyFileSync(at('frontend/assets/industrial/batch03/lab/fabricator_carriage.png'),at(dir+'fabricator_carriage.png'));
 fs.writeFileSync(mp,JSON.stringify(manifest,null,2)+'\n');
 const cp=at('docs/station-remaster/props-v3/coverage.json'),coverage=JSON.parse(fs.readFileSync(cp));
 for(const row of coverage.props)if(manifest.props[row.id])Object.assign(row,{status:'new-design-awaiting-review',views:Object.keys(manifest.props[row.id].views)});
 coverage.newDesigns=coverage.props.filter(p=>p.status==='new-design-awaiting-review').length;coverage.remainingFullRedesign=coverage.catalog-coverage.approved-coverage.newDesigns;fs.writeFileSync(cp,JSON.stringify(coverage,null,2)+'\n');
 console.log(JSON.stringify({added:Object.keys(specs),newDesigns:coverage.newDesigns}));
})().catch(e=>{console.error(e);process.exitCode=1;});
