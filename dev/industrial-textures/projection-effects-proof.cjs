'use strict';
const fs=require('node:fs'),path=require('node:path');
const sharp=require('C:/Users/andro/gen-trees/industrial-textures-0912/node_modules/sharp');
const root='frontend/assets/industrial/projection-correction',out='docs/station-remaster/projection-effects';
const manifest=JSON.parse(fs.readFileSync(root+'/manifest.json'));
const effects=require('../../frontend/app/projection-prop-effects.js');
const groups=[
 'desk desk2 console consoleL pixelrig bench workbench intake bay filter merger splitter joiner loop outbox connector_portal comms_dish comms_uplink comms_beacon war_intelcab rack core gigs_servercart bridge_relaystack',
 'studio airlock missionboard trophycase bridge_consolebank bridge_tacticaltable bridge_equipmentbay bigscreen holotable screens tank ticker chartwall wartable bridge_tacscreen bridge_dispatch_pylon bridge_orderqueue war_pivotpanel war_threatcore fabricator vat tube research_corelens research_trendpillar',
 'research_samplecart etsy_threadrack etsy_dyevat etsy_kiln etsy_packbot rackV treasury_coinsorter treasury_token_furnace commswall comms_inbox gigs_thumbwall gigs_amp pub_publishpress pub_outboundchute pub_mailpod arc_indexwall arc_microfiche djbooth speaker bar tv arcade arcade2 jukebox',
 'quarters_pooltable quarters_vending quarters_minifridge coffee treasury_pnl_holo arc_floorlight lavalamp crt_pile terrarium holopet plasmaglobe gachapon desklamp radio deskterminal modelship steamvent fishtank pinball cryopod incubator camerarig camerarig_r industrial_servicecab'
];
(async()=>{fs.mkdirSync(out,{recursive:true});for(let n=0;n<groups.length;n++){
 const ids=groups[n].split(' '),layers=[];const labels=[],outlines=[];
 for(let i=0;i<ids.length;i++){const id=ids[i],v=manifest.props[id].views.s,ox=i%6*200,oy=Math.floor(i/6)*230;
  const png=await sharp(root+'/'+v.image).resize({width:180,height:190,fit:'inside'}).png().toBuffer({resolveWithObject:true});
  layers.push({input:png.data,left:ox+Math.round((200-png.info.width)/2),top:oy+32});
  for(const poly of effects.regions[id]?.s||[]){const points=poly.map(p=>[ox+(200-png.info.width)/2+p[0]*png.info.width,oy+32+p[1]*png.info.height].join(',')).join(' ');outlines.push(`<polygon points="${points}" fill="#ff77ff" fill-opacity=".18" stroke="#ff77ff" stroke-width="1"/>`);}
  labels.push(`<text x="${ox+5}" y="${oy+16}">${id}</text>`);
 }
 const text=Buffer.from(`<svg width="1200" height="920"><style>text{font:12px monospace;fill:#fff}</style>${labels.join('')}</svg>`);layers.push({input:text,left:0,top:0});
 await sharp({create:{width:1200,height:920,channels:4,background:'#303638'}}).composite(layers).png().toFile(out+'/sources-'+(n+1)+'.png');
 const overlay=Buffer.from(`<svg width="1200" height="920">${outlines.join('')}</svg>`);layers.push({input:overlay,left:0,top:0});
 await sharp({create:{width:1200,height:920,channels:4,background:'#303638'}}).composite(layers).png().toFile(out+'/regions-'+(n+1)+'.png');
}})().catch(e=>{console.error(e);process.exitCode=1;});
