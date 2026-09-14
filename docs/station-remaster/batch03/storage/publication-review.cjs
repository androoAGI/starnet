'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const here=__dirname,root=path.resolve(here,'../../../..'),out=path.join(root,'frontend/assets/industrial/batch03/storage');
const ids=['outbox','connector_portal','pub_publishpress','pub_outboundchute','pub_mailpod'];
const selections={
outbox:{receivingMouth:[[375,180],[832,180],[832,505],[375,505]],conveyorCargoSurface:[[420,625],[785,625],[805,1005],[398,1005]],statusPlate:[[966,359],[1080,359],[1080,409],[966,409]]},
connector_portal:{statusStrip:[[327,249],[536,249],[536,318],[327,318]],socketTop:[[382,451],[480,451],[480,541],[382,541]],socketMiddle:[[355,746],[507,746],[507,833],[355,833]],socketBottom:[[379,1046],[487,1046],[487,1136],[379,1136]]},
pub_publishpress:{emptyThroat:[[418,656],[794,656],[794,696],[418,696]],outputTray:[[380,850],[827,850],[852,1060],[355,1060]],parkedPlaten:[[343,416],[870,416],[870,559],[343,559]],statusPanel:[[1032,694],[1135,694],[1135,789],[1032,789]]},
pub_outboundchute:{hopperOpening:[[250,165],[650,165],[583,307],[303,307]],capsuleLane:[[391,627],[509,627],[509,1280],[391,1280]]},
pub_mailpod:{westEmptyBay:[[270,475],[629,475],[630,662],[248,662]],eastEmptyBay:[[861,476],[1225,476],[1239,662],[846,662]],westIndicator:[[434,390],[454,390],[454,410],[434,410]],eastIndicator:[[1034,390],[1054,390],[1054,410],[1034,410]]}};
const round=n=>Math.round(n*1000)/1000;
(async()=>{const records=[],layers=[];for(let i=0;i<ids.length;i++){
const id=ids[i],r=JSON.parse(fs.readFileSync(path.join(here,id+'.export.json'))),c=r.crop,b=r.bounds,s=Math.min(b.width/c.width,b.height/c.height),bx=b.x+(b.width-c.width*s)/2,by=b.y+b.height-c.height*s;
const regions={};for(const [key,points] of Object.entries(selections[id]))regions[key]={sourcePixels:points,exportPixels:points.map(([x,y])=>[x-c.left,y-c.top]),worldPixels:points.map(([x,y])=>[round(bx+(x-c.left)*s),round(by+(y-c.top)*s)])};
const item={id,measurement:'Conservative manual visual selection inside inspected source surfaces; conversion uses PropRemaster.fit uniform bottom-centered mapping. Owner must verify live.',footprint:r.footprint,worldEnvelope:b,uniformScale:s,renderedArtBox:{x:bx,y:by,width:c.width*s,height:c.height*s},contact:{x:bx+c.width*s/2,y:b.y+b.height},regions,liveIntegrated:false};if(id==='outbox')item.existingWorldCargoContract={shippedPalletOrigin:{x:12,y:30},note:'world.js draws shipped pallet from real known done count at footprint center and bottom+6. Preserve separately; generated art includes no floor pallet or finished crates.'};if(id==='pub_publishpress')item.animationNote='Platen is authored parked. A moving-platen implementation must mask/recompose it before motion; static full-image override would lose native cycle.';if(id==='connector_portal')item.stateNote='All sockets empty, strip dark. Bind/server/tool state and pulses must come from real connector poll and calls.';
fs.writeFileSync(path.join(here,id+'.anchors.json'),JSON.stringify(item,null,2)+'\n');records.push(item);
const x=(i%3)*350,y=Math.floor(i/3)*470;
layers.push({input:await sharp(path.join(out,id+'.png')).resize({width:310,height:265,fit:'inside'}).png().toBuffer(),left:x+20,top:y+15});
layers.push({input:path.join(here,id+'.scale.png'),left:x+20,top:y+295});
layers.push({input:Buffer.from('<svg width="340" height="25"><text x="0" y="18" font-family="Arial" font-size="16" fill="#d4dbdd">'+id+'</text></svg>'),left:x+10,top:y+445});
}await sharp({create:{width:1050,height:940,channels:4,background:'#272b2f'}}).composite(layers).png().toFile(path.join(here,'publication-contact-sheet.png'));
fs.writeFileSync(path.join(here,'publication-anchors.json'),JSON.stringify({version:1,tilePixels:12,regionsAreLiveVerified:false,records},null,2)+'\n');
const all=fs.readdirSync(here).filter(n=>n.endsWith('.export.json')).map(n=>JSON.parse(fs.readFileSync(path.join(here,n))));
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({version:1,lane:'storage',status:'17 painted/new exports; awaiting owner live review',tilePixels:12,runtimeIntegrated:false,records:all},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
