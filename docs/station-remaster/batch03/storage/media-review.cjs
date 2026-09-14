'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const here=__dirname,root=path.resolve(here,'../../../..'),out=path.join(root,'frontend/assets/industrial/batch03/storage');
const inventory=require(path.join(root,'dev/industrial-textures/prop-inventory.json'));
const ids=['djbooth','speaker','tv','arcade','arcade2','jukebox','gigs_thumbwall','gigs_amp','pinball','gachapon','holopet','deskterminal'];
const rect=(x,y,r,b)=>[[x,y],[r,y],[r,b],[x,b]];
const selections={
djbooth:{leftPlatter:rect(260,259,553,439),rightPlatter:rect(1078,259,1390,440),equalizer:rect(721,207,923,235),leftReadout:rect(518,216,612,233),rightReadout:rect(1047,216,1132,232),mixer:rect(651,249,985,483)},
speaker:{woofer:rect(310,783,708,1160),tweeter:rect(440,494,591,626),powerLens:rect(720,1195,749,1229)},
tv:{screen:rect(241,326,1292,653)},
arcade:{screen:rect(283,411,635,633),joystick:rect(280,716,338,814)},
arcade2:{screen:rect(292,450,616,695),leftTrackball:rect(230,817,309,885),rightTrackball:rect(519,817,595,885)},
jukebox:{record:rect(349,271,676,584),status:rect(417,656,607,698),westLightTube:rect(174,424,215,621),eastLightTube:rect(803,424,847,621)},
gigs_thumbwall:{screen1:rect(177,302,514,489),screen2:rect(586,302,923,489),screen3:rect(993,302,1329,489),screen4:rect(177,552,514,742),screen5:rect(586,552,923,742),screen6:rect(993,552,1329,742)},
gigs_amp:{meter:rect(803,364,889,415),powerLens:rect(942,376,967,405),speakerCloth:rect(145,502,968,1138)},
pinball:{score:rect(297,212,666,299),playfield:[[369,437],[598,437],[684,954],[286,954]],lowerFlipperArea:rect(330,824,630,954),upperBumperWest:rect(380,465,427,487),upperBumperEast:rect(545,465,589,487),middleBumper:rect(464,523,505,545)},
gachapon:{capsuleReservoir:rect(228,368,733,805),crank:rect(350,1005,602,1060),pickupMouth:rect(357,1191,596,1349)},
holopet:{petLayer:rect(68,178,742,1657),emitterLayer:rect(90,1781,681,1925),emitterLens:rect(261,1815,513,1857)},
deskterminal:{screen:rect(369,371,807,670),keyboard:rect(227,815,851,990),indicator:rect(936,428,963,444)}
};
const notes={
djbooth:'Platters parked; use leisure work for spin/accent and readout spectrum. Rotate only extracted platter component, never full upright bitmap.',
speaker:'Neutral cone and colored lens are baked. Cone pumping needs masked/recomposed cone; optional table mount lifts 8 world pixels.',
tv:'Blank screen for cosmetic channel graphics. Preserve leisure watch trigger and screen light.',
arcade:'Blank game screen for leisure-driven decorative gameplay; no provider telemetry.',
arcade2:'Blank game screen and parked trackballs; preserve leisure-driven gameplay.',
jukebox:'Remain unpowered until actual /api/spotify/status connected:true. Only real spotify_* completion supplies 900ms success/failure cue. Record is parked; spin needs extracted disc or reauthored runtime overlay. Tubes are unlit amber material.',
gigs_thumbwall:'Six blank panes for cosmetic thumbnails, never invented live task status. Nonblocking placement contract; no free-standing deep cabinet.',
gigs_amp:'Meter needle is baked at rest; to animate mask/recompose meter. Optional surface mount rise8. Cosmetic clock only.',
pinball:'No moving ball or lower flippers are baked. Render both in lower open playfield and ball across playfield; fixed side rails are geometry. Cosmetic attract motion and actual leisure work stay distinct.',
gachapon:'Reservoir capsules are decorative static stock, not real inventory. Crank baked at rest; motion needs masked/recomposed crank. Pickup mouth empty for cosmetic drop.',
holopet:'Corrected flush deck disk matches nonblocking walk-over contract. Pet/disk separated by transparent gap; extract pet region for bob/sway/dropout scanline. No contact shadow on hologram. Rejected tall pedestal source retained, never integrate.',
deskterminal:'Blank screen for cosmetic cursor/content, no invented harness status. Optional table lift8.'
};
const round=n=>Math.round(n*1000000)/1000000;
function enrich(item,r){for(const reg of Object.values(item.regions)){reg.sourceNormalized=reg.sourcePixels.map(([x,y])=>[round(x/r.sourceWidth),round(y/r.sourceHeight)]);reg.exportNormalized=reg.exportPixels.map(([x,y])=>[round(x/r.crop.width),round(y/r.crop.height)]);}return item;}
(async()=>{const records=[],layers=[];for(let i=0;i<ids.length;i++){
const id=ids[i],r=JSON.parse(fs.readFileSync(path.join(here,id+'.export.json'))),c=r.crop,b=r.bounds,s=Math.min(b.width/c.width,b.height/c.height),bx=b.x+(b.width-c.width*s)/2,by=b.y+b.height-c.height*s,inv=inventory.props.find(p=>p.id===id);
const regions={};for(const [key,points] of Object.entries(selections[id]))regions[key]={sourcePixels:points,exportPixels:points.map(([x,y])=>[x-c.left,y-c.top]),worldPixels:points.map(([x,y])=>[round(bx+(x-c.left)*s),round(by+(y-c.top)*s)])};
const item=enrich({id,measurement:'Conservative manually inspected source regions, normalized to full source and cropped final; world conversion uses uniform bottom-centered fit. Owner must verify live.',sourceDimensions:{width:r.sourceWidth,height:r.sourceHeight},crop:c,footprint:r.footprint,worldEnvelope:b,uniformScale:s,contact:{x:bx+c.width*s/2,y:b.y+b.height},supportedViews:inv.orientation,geometry:inv.geometry,leisureUse:inv.leisureUse,originalAnimationTriggers:inv.liveAnimationTriggers,integrationNote:notes[id],regions,liveIntegrated:false},r);
fs.writeFileSync(path.join(here,id+'.anchors.json'),JSON.stringify(item,null,2)+'\n');records.push(item);
const x=i%4*300,y=Math.floor(i/4)*385;
layers.push({input:await sharp(path.join(out,id+'.png')).resize({width:270,height:240,fit:'inside'}).png().toBuffer(),left:x+15,top:y+10});
layers.push({input:path.join(here,id+'.scale.png'),left:x+15,top:y+258});
layers.push({input:Buffer.from('<svg width="290" height="22"><text x="0" y="16" font-family="Arial" font-size="15" fill="#d4dbdd">'+id+'</text></svg>'),left:x+10,top:y+363});
}
await sharp({create:{width:1200,height:1155,channels:4,background:'#272b2f'}}).composite(layers).png().toFile(path.join(here,'media-contact-sheet.png'));
fs.writeFileSync(path.join(here,'media-anchors.json'),JSON.stringify({version:1,tilePixels:12,regionsAreLiveVerified:false,normalizedDefinitions:{sourceNormalized:'x/fullSourceWidth,y/fullSourceHeight',exportNormalized:'x/croppedWidth,y/croppedHeight'},records},null,2)+'\n');
const pub=JSON.parse(fs.readFileSync(path.join(here,'publication-anchors.json')));
pub.normalizedDefinitions={sourceNormalized:'x/fullSourceWidth,y/fullSourceHeight',exportNormalized:'x/croppedWidth,y/croppedHeight'};
for(const p of pub.records){const r=JSON.parse(fs.readFileSync(path.join(here,p.id+'.export.json')));enrich(p,r);p.sourceDimensions={width:r.sourceWidth,height:r.sourceHeight};p.crop=r.crop;fs.writeFileSync(path.join(here,p.id+'.anchors.json'),JSON.stringify(p,null,2)+'\n');}
fs.writeFileSync(path.join(here,'publication-anchors.json'),JSON.stringify(pub,null,2)+'\n');
const all=fs.readdirSync(here).filter(n=>n.endsWith('.export.json')).map(n=>JSON.parse(fs.readFileSync(path.join(here,n))));
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({version:1,lane:'storage',status:all.length+' painted/new exports; awaiting owner live review',tilePixels:12,runtimeIntegrated:false,records:all},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
