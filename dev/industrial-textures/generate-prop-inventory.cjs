'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createCanvas,Image}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'), source=p=>fs.readFileSync(path.join(root,p),'utf8');
const files=['frontend/app/propsprites.js','frontend/app/propanchor.js','frontend/app/worldmodel.js','frontend/app/world.js','frontend/app/toolprops.js','frontend/app/industrialtextures.js'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const document={documentElement:{dataset:{},style:{setProperty(){}}},fonts:{status:'loaded'},addEventListener(){},createElement:()=>createCanvas(1,1)};
const window={addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}})};
const U=new Function('window','document',source('frontend/js/util.js')+';return U;')(window,document);
class Asset extends Image {set src(url){super.src=fs.readFileSync(path.join(root,'frontend',url));}}
async function load(mode){
 const env={document,window,URLSearchParams,Image:Asset,location:{search:mode?'':'?textures=classic'},module:{exports:{}}};
 vm.runInNewContext(source('frontend/app/industrialtextures.js'),env);
 const pack=env.module.exports;await pack.ready;
 if(mode&&!pack.enabled())throw Error(JSON.stringify(pack.status()));
 const scope={document,window,U,IndustrialTextures:pack,module:{exports:{}}};
 vm.runInNewContext(source('frontend/app/propsprites.js'),scope);
 return {PS:scope.module.exports,pack};
}
const sampleTimes=[1000,1193,1547,2011,2671,3463,4919,6287,9103];
function probe(PS,p){
 const cv=createCanvas(240,240),ctx=cv.getContext('2d');
 const f={id:'inventory-'+p.id,t:p.id,x:6,y:7,w:p.w,h:p.h};
 function paint(t,work){
  ctx.resetTransform();ctx.clearRect(0,0,240,240);PS.setCtx(ctx);PS.setNow(t);PS.draw(f,work);
  return hash(ctx.getImageData(0,0,240,240).data);
 }
 paint(sampleTimes[0],false);paint(sampleTimes[0],false);
 const idle=sampleTimes.map(t=>paint(t,false)), working=sampleTimes.map(t=>paint(t,true));
  paint(sampleTimes[0],false);
 const pixels=ctx.getImageData(0,0,240,240).data;let minX=240,minY=240,maxX=-1,maxY=-1;
 for(let yy=0;yy<240;yy++)for(let xx=0;xx<240;xx++)if(pixels[(yy*240+xx)*4+3]>=160){
  minX=Math.min(minX,xx);maxX=Math.max(maxX,xx);minY=Math.min(minY,yy);maxY=Math.max(maxY,yy);}
 return {idleFrameVariants:new Set(idle).size,workFrameVariants:new Set(working).size,
  respondsToWorkFlag:idle.some((h,i)=>h!==working[i]),
  opaqueBoundsRelativeToFootprint:{x:minX-f.x*12,y:minY-f.y*12,w:maxX-minX+1,h:maxY-minY+1,alphaThreshold:160}};
}
(async()=>{
 const {PS}=await load(true), classic=(await load(false)).PS;
 const mapText=source('frontend/app/worldmodel.js').match(/const CAP_PROP_MAP = (\{[\s\S]*?\n  \});/)[1];
 const cap=vm.runInNewContext('('+mapText+')');
 const rows=PS.CATALOG.map(p=>{
 const baseline=classic.spec(p.id), views=PS.facings(p.id).map(r=>({r,front:['south','west','north','east'][r],...PS.footprintAt(p.id,r),
    type:PS.viewAt(p.id,r).turned?'flat-plan-transform':PS.viewAt(p.id,r).mirror?'mirrored-authored-view':'authored-view'}));
 return {id:p.id,label:p.label,family:p.cat,tier:p.tier,oldConcept:p.desc||p.label,
  classicBox:{w:baseline.w,h:baseline.h},remasterBox:{w:p.w,h:p.h},tilePixels:PS.TILE,
  orientation:{facings:views,canMirror:PS.canMirror(p.id),classicFacings:classic.facings(p.id)},
  geometry:{blocks:!!p.blocks,flat:!!p.flat,tableSurface:!!p.surface,requiredMount:p.mount||null,optionalSurfaceMount:!!p.stack,surfaceRisePixels:8},
  assignedWorkstation:!!p.seat,leisureUse:p.use||null,capabilityObjectType:cap[p.id]||null,
  animatedCatalogFlag:!!p.animated,light:PS.EMIT[p.id]||null,
  sampledAnimation:{remaster:probe(PS,p),classic:probe(classic,baseline)},
 };
 });
 const rasterArt={
  desk:['workstation.png','workstation-compact.png','remaster/workstation-e.png','remaster/workstation-n.png','remaster/workstation-compact-n.png'],
  desk2:['workstation.png','workstation-compact.png','remaster/workstation-e.png','remaster/workstation-n.png','remaster/workstation-compact-n.png'],
  chair:['chair-s.png','chair-e.png','chair-n.png'],
  bridge_consolebank:['console-bank.png'],bridge_tacticaltable:['tactical-table.png'],
  bridge_equipmentbay:['equipment-bay.png'],bridge_deckperimeter:['deck-perimeter.png']
 };
 const pulseToolFamilies={
 cabinet:['fs.*'],dish:['web_search','web_fetch','web_request','browser.* excluding browser.test_*','channel.*','connectors.list'],
 notebook:['notebook.*','skill.*','recall_conversation','widget.get','widget.set'],
 studio:['image_*','voice_generate'],jukebox:['spotify_*']
 };
 const specialTriggers={
  connector_portal:['Successful /api/connectors poll supplies bound server state and toolCount; removed servers clear on successful reconciliation.','Real mcp__<connector>__* calls pulse that bound connector for 900 ms.'],
  workbench:['shell.exec / verify.result resolve the acting room’s workbench instance; 900 ms success pulse or distinct red failed verification.'],
  jukebox:['/api/spotify/status connected:true powers lamps, disc and bubble chase; disconnected is dark. This is actual Spotify capability despite its cosmetic catalog tier.'],
  bay:['Assigned agent binding and dock name alter physical label.','Hero working flag or a non-awaiting crew workUntil > now lights its assigned bay.'],
  outbox:['Real reply delivery flashes for 600 ms after the outbound crate reaches the chute.','ReturnStore pending count renders uncollected result crates (capped visible stack and count).'],
  airlock:['Saved live door state selects open, closed or jammed iris geometry; jam sparks use the frame clock.'],
  missionboard:['Real open quest count, station-gap flag, routine jam flag and pending autojob proposal count drive pins and warnings.'],
  trophycase:['Real earned trophy count fills the case; JourneyStore reached-goal stage drives crown beacons.'],
  bunk:['Actual sleeping body sets sleeper, splits quilt into drawOver, and preserves pillow/blanket body occlusion.']
 };
 const sourceText=source('frontend/app/propsprites.js');
 for(const row of rows){
  row.art={
   implementation:rasterArt[row.id]?'authored-reference-raster':'native-procedural-construction',
   assets:(rasterArt[row.id]||[]).map(p=>'frontend/assets/industrial/'+p),
   detailStatus:rasterArt[row.id]?'Reference-derived silhouette exists; exact dimensions, state masks and views still require final acceptance.':'Industrial palette/construction pass exists; no individually authored remaster raster silhouette yet.',
   completion:'baseline-audited; comprehensive prop pass not accepted'
  };
  row.liveAnimationTriggers=[...(specialTriggers[row.id]||[])];
  if(row.assignedWorkstation)row.liveAnimationTriggers.push('world.workstationLit: assigned hero.working or assigned crew.working with compute eligibility; real token/tool heat and only a published progress fraction. At this baseline this is work-state gating, not strict physical occupancy.');
  if(pulseToolFamilies[row.capabilityObjectType])row.liveAnimationTriggers.push('Real '+pulseToolFamilies[row.capabilityObjectType].join(', ')+' tool completion chooses the granting prop instance and overlays a 900 ms success accent or red failure surge.');
  if(row.leisureUse)row.liveAnimationTriggers.push('Actual leisure usingProp / watchProp can set work on this prop; body approach and use animation follow leisureUse. In the baseline draw work expression this leisure trigger directly checks the hero, not a separate crew leisure flag.');
  if(row.sampledAnimation.remaster.idleFrameVariants>1)row.liveAnimationTriggers.push('Autonomous sprite clock animation is present in the sampled default state; cosmetic motion is not evidence of provider work, route decisions or external state.');
  if(!row.liveAnimationTriggers.length)row.liveAnimationTriggers.push('No direct event-driven or sampled default sprite animation. Preserve static art; no invented status or progress.');
  row.anchorContract=row.assignedWorkstation?'deskSeat: adjacent walkable center-out approach; desk/desk2 respect remaster facing, others stay south. Fractional render center shifts at most half a tile; separate generated seatchair.':
   row.id==='bunk'?'planBedSleep: separate mattress claim and lying pose; frame/pillow below body, quilt above.':
   ['recliner','recliner_r'].includes(row.id)?'planCouchSit with SIDE_SEAT: fixed west/east view, dx -2/+2 px, lift 2 px, near-arm overlay above body.':
   row.leisureUse?.kind==='seat'?'planSeat: one occupant claim, walk to an adjacent tile, render on the seat tile at bottom minus 1 px plus per-type seat lift; explicit rotated facing beats counter inference.':
   row.leisureUse?.kind==='couch'?'planCouchSit: actual cushion claims despite generic sit:false; body foot is cushion front at bottom minus 2 px; wide sofa reserves arms and y-sorts sofa back in front. Turned booth seating must be rechecked before promising all angles.':
   row.leisureUse?'PropAnchor derives reachable edge approach; useApproach rotates relative preference with r. Preserve standing leisure action unless special planner supplies a real body anchor.':
   row.geometry.flat?'Flat floor pass beneath bodies and other props; no body, seat, mount or collision.':
   row.geometry.requiredMount==='surface'?'Requires table host; contact origin lifted exactly 8 world pixels.':
   row.geometry.optionalSurfaceMount?'Can sit on bare deck or valid table; table mount lifts contact origin exactly 8 world pixels.':
   row.geometry.requiredMount==='wall'?'Wall-host placement; preserve host test and contact line.':'No leisure seat anchor. Footprint is the placement/pathfinding rectangle; upright visual rise is independent of the reserved box.';
  row.directionalArtNeed=row.geometry.flat?'No elevated projection needed; exact integer quarter-turn of flat pattern is valid.':
   row.family==='workflow'?'Do not offer cosmetic rotation: mouth/arrow direction belongs to real routing. Directional art needs a matching route contract.':
   row.orientation.facings.length>1?'Keep offered authored projections and mirror semantics. Verify contact, standing height, occlusion and seat/mount geometry in every offered facing.':
   row.assignedWorkstation?'Author east and north views plus grounded mirrored west, then extend actual front approach and seat contracts before enabling rotation.':
   row.geometry.requiredMount==='wall'?'Author wall-specific profiles only for supported mounting walls; never rotate an upright panel bitmap.':
   'South-only at baseline. For free placement, author side/rear projections rather than rotate the elevation; preserve upright box unless footprint is genuine plan.';
  const needle='id: "'+row.id+'"';
  row.sourceEvidence={catalog:'frontend/app/propsprites.js:'+String(sourceText.slice(0,sourceText.indexOf(needle)).split('\n').length),
   geometry:'frontend/app/propsprites.js:11006',drawState:'frontend/app/propsprites.js:11279',liveWorld:'frontend/app/world.js:6029'};
 }
 if(rows.length!==160||new Set(rows.map(p=>p.id)).size!==rows.length)throw Error('Catalog coverage changed; update audit scope explicitly.');
 for(const row of rows)for(const asset of row.art.assets)if(!fs.existsSync(path.join(root,asset)))throw Error('Missing catalog art '+asset);
 if(rows.some(p=>p.sampledAnimation.remaster.opaqueBoundsRelativeToFootprint.w<=0))throw Error('Empty native prop sample.');
 if(process.argv.includes('--sheet')){
  const out=path.join(root,'dev/.scratch-workspace/prop-inventory');fs.mkdirSync(out,{recursive:true});
  for(const [mode,renderer] of [['classic',classic],['industrial',PS]]){
   const ordered=rows.slice().sort((a,b)=>a.family.localeCompare(b.family)||a.id.localeCompare(b.id));
   const cv=createCanvas(2000,2940),ctx=cv.getContext('2d');ctx.fillStyle='#15191a';ctx.fillRect(0,0,2000,2940);
   ctx.fillStyle='#c5beb0';ctx.font='20px sans-serif';ctx.fillText('CATALOG BASELINE / '+mode.toUpperCase()+' / 160 IDs / IDLE RENDERER FIXTURE',20,30);
   for(let i=0;i<ordered.length;i++){
    const p=ordered[i],x=(i%10)*200,y=60+Math.floor(i/10)*180,b=renderer.spec(p.id);
    ctx.fillStyle=i%2?'#191e1d':'#111719';ctx.fillRect(x+2,y,196,178);
    ctx.fillStyle='#bbb4a5';ctx.font='11px sans-serif';ctx.fillText(p.id,x+7,y+16);
    ctx.fillStyle='#7f8b83';ctx.font='10px sans-serif';ctx.fillText(p.family+' / '+b.w+'x'+b.h,x+7,y+31);
    const sc=Math.min(2.5,170/(b.w*12+12),120/(b.h*12+28));
    ctx.save();ctx.translate(x+100-b.w*6*sc,y+90);ctx.scale(sc,sc);
    ctx.strokeStyle='#555039';ctx.lineWidth=.4;ctx.strokeRect(0,0,b.w*12,b.h*12);
    renderer.setCtx(ctx);renderer.setNow(2671);renderer.draw({id:'sheet-'+p.id,t:p.id,x:0,y:0,w:b.w,h:b.h},false);ctx.restore();
   }
   fs.writeFileSync(path.join(out,mode+'.png'),cv.toBuffer('image/png'));
  }
 }
 const preview=require('./command-deck.cjs')();
 const output={schemaVersion:1,sourceCommit:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),scope:'Snapshot before the comprehensive prop artwork pass. Source inspection and native renderer samples; not live behavior acceptance.',
  sourceHashes:Object.fromEntries(files.map(p=>[p,hash(source(p))])),sampling:{timesMs:sampleTimes,workFlag:[false,true],pixelCanvas:[240,240],includesFloorLight:false,states:'Default connector disconnected, no pulses, no mission/trophy counts. Work=true is only a renderer probe, not simulated harness work.'},
  counts:{catalog:rows.length,functionalTier:rows.filter(p=>p.tier==='functional').length,cosmeticTier:rows.filter(p=>p.tier==='cosmetic').length,capabilityMapped:rows.filter(p=>p.capabilityObjectType).length,authoredRasterIds:rows.filter(p=>p.art.assets.length).length,nativeConstructedIds:rows.filter(p=>!p.art.assets.length).length,multipleFacingIds:rows.filter(p=>p.orientation.facings.length>1).length,clockAnimatedDefault:rows.filter(p=>p.sampledAnimation.remaster.idleFrameVariants>1).length,sampledStaticDefault:rows.filter(p=>p.sampledAnimation.remaster.idleFrameVariants===1).length,legacyAnimatedFlag:rows.filter(p=>p.animatedCatalogFlag).length,lightEmitterIds:rows.filter(p=>p.light).length,leisureDescriptors:rows.filter(p=>p.leisureUse).length,categories:Object.fromEntries(Object.keys(PS.CATS).map(k=>[k,PS.CATS[k].length]))},
  preview:{source:'dev/industrial-textures/command-deck.cjs',instances:preview.length,types:Object.fromEntries([...new Set(preview.map(p=>p.t))].map(t=>[t,preview.filter(p=>p.t===t).length])),placements:preview},
  props:rows};
 fs.writeFileSync(path.join(__dirname,'prop-inventory.json'),JSON.stringify(output,null,2)+'\n');
 console.log(JSON.stringify(output.counts));
 if(process.argv.includes('--verbose'))for(const mode of ['classic','remaster']){
 console.log(mode+' moving: '+rows.filter(p=>p.sampledAnimation[mode].idleFrameVariants>1).map(p=>p.id).join(' '));
 console.log(mode+' work-responsive: '+rows.filter(p=>p.sampledAnimation[mode].respondsToWorkFlag).map(p=>p.id).join(' '));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
