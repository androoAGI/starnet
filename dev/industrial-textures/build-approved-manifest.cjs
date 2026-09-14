'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root='frontend/assets/industrial/approved-sheet';
const structure=JSON.parse(fs.readFileSync('dev/industrial-textures/prop-structure-manifest.json'));
const old=JSON.parse(fs.readFileSync('frontend/assets/industrial/props-v3/manifest.json'));
const occupied=new Set('desk desk2 console consoleL pixelrig bench screens bigscreen holotable bridge_consolebank bridge_tacticaltable bridge_tacscreen research_corelens research_trendpillar deskterminal'.split(' '));
const screenAmbient=new Set('tv ticker chartwall commswall gigs_thumbwall crt_pile'.split(' '));
// Measured station cadet is 21.57 world pixels tall. Seats need human-scale
// backs and cushions, while consoles/cabinets may legitimately rise above it.
const heightCaps={couch:23,industrial_bench:17,chair:22,dinerchair:21,booth:24,podchair:26,beanbag:14,recliner:23,recliner_r:23,lowtable:18,glasstable:18,loungetable:18,sidetable:18,industrial_roundtable:20,dinertable:24,longtable:24};
const surfaces={lowtable:[[.08,.08],[.92,.08],[.97,.59],[.03,.59]],glasstable:[[.1,.05],[.9,.05],[.94,.58],[.06,.58]],loungetable:[[.24,.09],[.76,.09],[.89,.61],[.11,.61]],industrial_roundtable:[[.25,.07],[.75,.07],[.92,.5],[.08,.5]]};
(async()=>{
 const props={};
 for(const [id,p]of Object.entries(structure.props)){
  props[id]={views:{}};
  for(const [face,v]of Object.entries(p.views)){
   const image=id+(face==='s'?'':'-'+face)+'.png';if(!fs.existsSync(path.join(root,image)))continue;
   const {width,height}=await sharp(path.join(root,image)).metadata();
   // Footprint width sets physical scale. Upright source proportions set height;
   // old shallow procedural boxes must not flatten or miniaturize the artwork.
   let targetWidth=v.bounds.width,targetHeight=targetWidth*height/width;
   if(heightCaps[id]&&targetHeight>heightCaps[id]){targetHeight=heightCaps[id];targetWidth=targetHeight*width/height;}
   if(p.flat){targetHeight=Math.min(targetHeight,v.bounds.height);targetWidth=targetHeight*width/height;}
   if(targetHeight>v.footprint.h*12+44){targetHeight=v.footprint.h*12+44;targetWidth=targetHeight*width/height;}
   const bounds={x:+(v.bounds.x+(v.bounds.width-targetWidth)/2).toFixed(4),y:+(v.bounds.y+v.bounds.height-targetHeight).toFixed(4),width:+targetWidth.toFixed(4),height:+targetHeight.toFixed(4)};
   const result={image,sourceWidth:width,sourceHeight:height,footprint:v.footprint,bounds,mode:'approved',exposure:1};
   if(occupied.has(id)&&face!=='n')result.screenPower='occupied';
   else if(screenAmbient.has(id))result.screenPower='ambient';
   else if(id==='connector_portal')result.screenPower='bound';
   else if(id==='jukebox')result.screenPower='connected';
   const previous=old.props[id]?.views?.[face]||old.props[id]?.views?.s;
   if(previous?.mode==='pulse'||['machine','service'].includes(previous?.mode))result.activity=previous?.motion?.trigger==='ambient'?'ambient':previous?.motion?.trigger==='fired'||['workbench','connector_portal'].includes(id)?'fired':'work';
   if(face==='s'&&surfaces[id])result.surfaceSupport={space:'export-normalized',points:surfaces[id]};
   props[id].views[face]=result;
  }
 }
 const manifest={version:1,artSet:'owner-approved-160-sheet',source:'../complete-sheet/starnet-props-full-sheet.png',props};
 fs.writeFileSync(root+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({props:Object.keys(props).length,views:Object.values(props).reduce((n,p)=>n+Object.keys(p.views).length,0)}));
})();
