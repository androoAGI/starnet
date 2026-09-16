const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const w=fs.readFileSync('frontend/agent-demo/review-world.js','utf8'),s=fs.readFileSync('frontend/agent-demo/sprites.js','utf8');
let time=1000;const angles={east:0,'south-east':Math.PI/4,south:Math.PI/2,'south-west':3*Math.PI/4,west:Math.PI,'north-west':-3*Math.PI/4,north:-Math.PI/2,'north-east':-Math.PI/4};
const catalog=JSON.parse(fs.readFileSync('frontend/agent-demo/catalog.json')).skins;
const skins=Object.fromEntries(catalog.map(x=>[x.renderSet,{set:x.renderSet,sourceStandingHeight:x.sourceStandingHeight}]));
const c={DATA:{SKINS:skins},SPRITES:{bodyScale:b=>19/skins[b.skin].sourceStandingHeight},performance:{now:()=>time},Math};vm.createContext(c);
vm.runInContext(w.slice(w.indexOf('  const DIR_A ='),w.indexOf('  /* ================= furniture')),c);
vm.runInContext(s.slice(s.indexOf('  const DIR8_A ='),s.indexOf('  /* prefer the 8-bucket')),c);
let cases=0,maxError=0;
// Walking must select the closest art angle even after holding a previous direction.
// Exercise every heading with a stale cardinal and with no faceA initialization.
let headingCases=0;
for(const skin of Object.keys(skins)) for(const stale of Object.keys(angles)) for(let degree=0;degree<360;degree++) {
 const heading=degree*Math.PI/180;
 const b={skin,state:'walk',dir:stale,_rD8:stale,_rA:angles[stale],_resolvedTravelHeading:heading};
 const selected=c.renderDir8(b,stale,false,time);
 const error=Math.abs(Math.atan2(Math.sin(angles[selected]-heading),Math.cos(angles[selected]-heading)))*180/Math.PI;
 assert(error<=22.50001,skin+' stale facing at '+degree+': '+selected);headingCases++;
}
for(const skin of Object.keys(skins))for(const delta of [0,Math.PI/4,Math.PI/2,Math.PI,-Math.PI/2])for(const dt of [1000/60,1000/30,100]){
 const b={skin,dir:'west',faceDir:'west',faceA:Math.PI,state:'walk',odo:27,odoAt:time,spd:15,_rA:Math.PI,_rAt:time};let distance=0;
 const heading=Math.PI+delta;
 for(let i=0;i<90;i++){time+=dt;const step=c.stepGait(b,Math.cos(heading)*100,Math.sin(heading)*100,100,28,false,dt);distance+=step;const dir=c.renderDir8(b,b.dir,false,time);const error=Math.abs(Math.atan2(Math.sin(angles[dir]-heading),Math.cos(angles[dir]-heading)))*180/Math.PI;if(step>.001){maxError=Math.max(maxError,error);assert(error<=73,skin+' faces away while travelling: '+error);}assert(Math.abs(b.odo-27-distance)<1e-7,'odometer includes non-travel');}
 b._gaitStart=null;const old=b.odo;time+=1000;c.stepGait(b,100,0,100,28,false,dt);assert(b.odo>=old,'walk restart resets stride phase');cases++;
}

for(const movement of [{x:-1,y:0,blocked:true},{x:0,y:0,blocked:true},{x:1,y:1,blocked:false}]){
 const b={_gaitStart:{x:0,y:0,odo:20},px:movement.x,py:movement.y,_travelHeading:0,_travelStep:1,odo:24};c.finishGait(b);
 assert.equal(b._strideBlocked,movement.blocked);assert.equal(b.odo,20+(movement.blocked?0:Math.hypot(movement.x,movement.y)));
 if(!movement.blocked)assert.equal(b._resolvedTravelHeading,Math.atan2(movement.y,movement.x));
}
const stale={_gaitStart:{x:0,y:0,odo:20},px:1,py:0,_travelHeading:0,_travelStep:0,odo:20};c.finishGait(stale);assert(stale._strideBlocked);assert.equal(stale.odo,20);
vm.runInContext(w.slice(w.indexOf('  function conversationWindow('),w.indexOf('  function myTurn(',w.indexOf('  function conversationWindow('))),c);
for(const n of [2,3])for(let t=0;t<60000;t+=17){let speakers=0;for(let i=0;i<n;i++)speakers+=Number(c.myTurnN(t,i,n,1700,1150));assert(speakers<=1,'conversation overlaps');const win=c.conversationWindow(t,1700,1150);assert(win.speakEnd<win.end,'missing listening gap');}
// Run the actual renderer with an instrumented drawing context: no generated images or world-state overrides.
const fake={width:144,height:144},frames={'approved_finn.rot.south':[fake]};
Object.assign(c,{frames,setForBody:b=>b.skin,loadedSets:new Set(['approved_finn']),loadSet:()=>{},bodyLight:()=>null,pick:()=> 'approved_finn.rot.south',pick8:()=> 'approved_finn.rot.south',isReviewSet:()=>true,tintFrames:()=>[fake],drawScaleFor:()=>.25,cycleUnitsFor:()=>10,getFootPad:()=>32,getTrackPad:()=>32,getFramePad:()=>32,groundShadow:()=>{},lightFrame:f=>f});
vm.runInContext(s.slice(s.indexOf('  function drawBody('),s.indexOf('  /* loading */')),c);
let feet=[];const ctx={getTransform:()=>({a:4}),save(){},restore(){},translate(){},transform(){},drawImage(f,x,y,width,height){feet.push(y+height*(112/144));}};
const b={skin:'approved_finn',id:'test',px:50,py:50,dir:'south',state:'idle',speaking:true,aph:1.7};let accents=[];
for(let t=1000;t<9000;t+=17){c.drawBody(ctx,b,t,{});accents.push(b._renderSpeechAccent);}
assert(Math.max(...feet)-Math.min(...feet)<1e-7,'speech lifts the feet');assert(Math.max(...accents)>.2,'speech never moves');assert(Math.min(...accents)<.01,'speech has no pauses');
c.drawBody(ctx,b,9100,{reducedMotion:true});assert.equal(b._renderSpeechAccent,0);
const result={cases,headingCases,skins:catalog.length,maxMovingFacingError:maxError,artificialStrideDistance:0,speechFootDrift:Math.max(...feet)-Math.min(...feet),conversationOverlap:false};fs.writeFileSync('output/agent-animation-study/motion-polish-19px/regression.json',JSON.stringify(result,null,2)+'\n');console.log(result);console.log('Motion regression: PASS');
