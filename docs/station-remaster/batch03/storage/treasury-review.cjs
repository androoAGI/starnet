'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const here=__dirname,root=path.resolve(here,'../../../..'),out=path.join(root,'frontend/assets/industrial/batch03/storage'),inventory=require(path.join(root,'dev/industrial-textures/prop-inventory.json'));
const ids=['safe','vault','shelf','gigs_servercart','goldcrate','gigs_partsbin','treasury_coinsorter','treasury_token_furnace','treasury_pnl_holo','crt_pile'];
const rect=(x,y,r,b)=>[[x,y],[r,y],[r,b],[x,b]],round=n=>Math.round(n*1000000)/1000000;
const selections={
safe:{status:rect(375,315,563,353),dial:rect(367,772,571,978),indicator:rect(454,1129,485,1152)},
vault:{status:rect(1126,425,1193,459),wheel:rect(640,444,868,681),westIndicator:rect(133,373,154,393),eastIndicator:rect(1389,375,1412,397)},
shelf:{statusStrip:rect(1590,297,1628,446),upperHardwareBay:rect(184,260,1534,447),lowerHardwareBay:rect(180,501,1525,675)},
gigs_servercart:{topReadout:rect(691,462,832,480),middleReadout:rect(691,625,832,644),bottomReadout:rect(691,790,832,808),topStatusStack:rect(869,455,882,528),middleStatusStack:rect(869,619,882,694),bottomStatusStack:rect(869,785,882,860)},
goldcrate:{closedLatch:rect(648,545,720,749)},
gigs_partsbin:{boltCompartment:[[164,219],[413,219],[383,652],[137,652]],collarCompartment:rect(485,218,689,653),plugCompartment:rect(765,218,965,653),moduleCompartment:rect(1064,217,1294,653)},
treasury_coinsorter:{feedHopper:[[131,87],[388,87],[363,172],[103,172]],leftCoinLane:[[257,461],[439,461],[402,599],[214,599]],middleCoinLane:[[665,460],[830,460],[799,650],[680,650]],rightCoinLane:[[1030,462],[1179,462],[1200,605],[1080,605]],leftRoller:rect(514,432,580,584),rightRoller:rect(893,433,959,585),counter:rect(1376,331,1525,403)},
treasury_token_furnace:{feedHopper:[[107,247],[413,247],[404,349],[85,349]],firebox:rect(316,1008,532,1193),outputChute:[[337,1418],[513,1418],[531,1518],[320,1518]],parkedDoor:[[29,1030],[199,963],[201,1268],[31,1355]],flueMouth:rect(596,162,711,205)},
treasury_pnl_holo:{emitterLens:[[541,318],[1204,318],[1315,417],[1168,513],[591,513],[457,417]]},
crt_pile:{upperScreen:rect(375,345,676,539),lowerScreen:rect(425,738,854,961)}
};
const notes={
safe:'Real fs.* completion chooses granting prop and drives 900ms success/failure. Blank status; no fake glow. Dial parked, movement requires component mask/recomposition. Footprint remains1x2.',
vault:'Real fs.* completion only. Closed thick door/wheel parked; no contents/count. Blank readout and unlit accent lenses. Do not rotate whole elevation.',
shelf:'File capability hardware, not books. Stored modules are decorative static stock; real fs.* completion drives right-hand status strip/accent. Blank strip provided.',
gigs_servercart:'Actual notebook.*, skill.*, recall_conversation, widget.get/set completion drives memory capability cues. Three blank readouts and unlit status stacks. Preserve cart handle and castors.',
goldcrate:'Entirely static closed chest. No currency count or glow; latch region identifies anatomy only, not suggested live progress.',
gigs_partsbin:'Decorative physical parts. Clock-based sheen may move; no claim of real stock. Optional tabletop lift8. All compartment parts baked; avoid duplicate runtime inventory.',
treasury_coinsorter:'Empty channels/blank counter. Owner supplies coin motion and any count; native autonomous counting is cosmetic, never real balance evidence. Moving roller accents stay inside roller regions.',
treasury_token_furnace:'Empty firebox and feed/output. Decorative native fire flicker goes behind mouth; no output count or token throughput is asserted. Door parked partly open, do not animate without component recomposition.',
treasury_pnl_holo:'Flush walk-over emitter ONLY is solid art and fitted to native opaque envelope10x5 at(1,5). Native cosmetic projection extends ABOVE solid bounds and is rendered separately. Do not squeeze chart into disk or add solid pedestal. If showing actual P&L, use supplied real values, not clock-generated digits.',
crt_pile:'Two shells with overhanging top monitor. Lower screen dead; upper screen accepts cosmetic static. Optional tabletop mount rises8. No fake task telemetry.'
};
(async()=>{const records=[],layers=[];for(let i=0;i<ids.length;i++){
const id=ids[i],r=JSON.parse(fs.readFileSync(path.join(here,id+'.export.json'))),c=r.crop,b=r.bounds,s=Math.min(b.width/c.width,b.height/c.height),bx=b.x+(b.width-c.width*s)/2,by=b.y+b.height-c.height*s,inv=inventory.props.find(p=>p.id===id),regions={};
for(const[key,pts]of Object.entries(selections[id]))regions[key]={sourcePixels:pts,sourceNormalized:pts.map(([x,y])=>[round(x/r.sourceWidth),round(y/r.sourceHeight)]),exportPixels:pts.map(([x,y])=>[x-c.left,y-c.top]),exportNormalized:pts.map(([x,y])=>[round((x-c.left)/c.width),round((y-c.top)/c.height)]),worldPixels:pts.map(([x,y])=>[round(bx+(x-c.left)*s),round(by+(y-c.top)*s)])};
const item={id,measurement:'Manually inspected conservative source-surface regions, mapped with uniform bottom-centered PropRemaster fit; not live verified.',sourceDimensions:{width:r.sourceWidth,height:r.sourceHeight},crop:c,sourceSha256:r.sourceSha256,outputSha256:r.outputSha256,footprint:r.footprint,worldEnvelope:b,tilePixels:12,uniformScale:s,contact:{x:bx+c.width*s/2,y:b.y+b.height},supportedViews:inv.orientation,geometry:inv.geometry,originalAnimationTriggers:inv.liveAnimationTriggers,integrationNote:notes[id],regions,liveIntegrated:false};
if(id==='treasury_pnl_holo')item.nativeProjectionContract={worldOrigin:{x:6,y:6},worldVisualBounds:{x:0,y:-5,width:12,height:11},note:'Translucent native chart not captured by alpha160 solid bounds. Project above disk; coordinates from existing source renderer, not a new bitmap region.'};
fs.writeFileSync(path.join(here,id+'.anchors.json'),JSON.stringify(item,null,2)+'\n');records.push(item);
const x=i%4*300,y=Math.floor(i/4)*395;
layers.push({input:await sharp(path.join(out,id+'.png')).resize({width:270,height:240,fit:'inside'}).png().toBuffer(),left:x+15,top:y+10});
layers.push({input:path.join(here,id+'.scale.png'),left:x+15,top:y+255});
layers.push({input:Buffer.from('<svg width="290" height="22"><text x="0" y="16" font-family="Arial" font-size="15" fill="#d4dbdd">'+id+'</text></svg>'),left:x+10,top:y+376});
}
await sharp({create:{width:1200,height:1185,channels:4,background:'#272b2f'}}).composite(layers).png().toFile(path.join(here,'treasury-contact-sheet.png'));
fs.writeFileSync(path.join(here,'treasury-anchors.json'),JSON.stringify({version:1,tilePixels:12,regionsAreLiveVerified:false,normalizedDefinitions:{sourceNormalized:'x/fullSourceWidth,y/fullSourceHeight',exportNormalized:'x/croppedWidth,y/croppedHeight'},records},null,2)+'\n');
const all=fs.readdirSync(here).filter(n=>n.endsWith('.export.json')).map(n=>JSON.parse(fs.readFileSync(path.join(here,n))));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const r of all){if(hash(fs.readFileSync(path.join(here,r.source)))!==r.sourceSha256||hash(fs.readFileSync(path.join(out,r.image)))!==r.outputSha256||r.subjectRgbChanges!==0||r.partialPixels!==0||r.transparentPixels<1||r.opaquePixels<1)throw Error('Proof failed '+r.id);}
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({version:1,lane:'storage',status:all.length+' painted/new exports; awaiting owner live review',tilePixels:12,runtimeIntegrated:false,records:all},null,2)+'\n');
console.log('All '+all.length+' source/output hashes and alpha/RGB ledgers verified.');
})().catch(e=>{console.error(e);process.exitCode=1;});
