'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../frontend/app/build.js'),'utf8');
const between = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture() {
  const s = {tool:'prop',buildGroup:'props',drag:null,dragPid:null,connectFrom:null,dupe:null,hoverPropId:'placed',propType:'chair',propRot:0,propMir:0,
    edits:0,releases:0,closed:0,focused:false,
    root:{querySelectorAll:()=>[],querySelector:()=>null},
    window:{matchMedia:()=>({matches:false})}, BUILD_GROUPS:[['props','Props',['prop']],['workflow','Conveyors',['line','belt']]],
    station:{propById:()=>({id:'placed',t:'chair',r:0,x:0,y:0,w:1,h:1})},
    cv:{}, FACE_WORD:['south','west','north','east'],
    orientEv:()=>({}), canTurn:()=>true, canFlip:()=>true, nextFace:(t,r,d)=>(r+d)&3,
    propBox:()=>({w:1,h:1}), propLabel:t=>t, cardTop:()=>null,
    hideTip(){},hidePropCard(){},toggleKit(){},renderPalette(){},repaintIcons(){},setHint(){},setCursor(){},renderFinCard(){},frameBlueprint(){},fitCamera(){},sfx(){},
    renderPropPreview(){},renderEquipmentInfo(){},flashTip(){},pushFlash(){},feedback(){}
  };
  s.station.faceProp=()=>{s.edits++;return{ok:true};}; s.station.mirrorProp=s.station.faceProp;
  s.cv.releasePointerCapture=()=>s.releases++;
  s.close=()=>s.closed++;
  vm.createContext(s);
  vm.runInContext(between('function releaseDrag()', 'let dupe = null;')+
    between('function selectTool(id, o)', '/* FRAME THE GHOST.')+
    source.match(/function deselectTool\(o\) \{[^\n]+/)[0]+'\n'+
    source.match(/const orientTarget = [^\n]+/)[0]+'\n'+
    between('function turnUnderCursor(dir)', '// open the right editor')+
    between('function onKey(ev)', 'function onKeyUp(ev)'),s);
  return s;
}
{
  const s=fixture();
  s.turnUnderCursor(1); s.flipUnderCursor();
  assert.equal(s.edits,0,'R/M cannot mutate hovered furniture while placing a new prop');
  assert.equal(s.propRot,1); assert.equal(s.propMir,1);
  s.tool='select'; s.turnUnderCursor(1); s.flipUnderCursor();
  assert.equal(s.edits,2,'hover rotation and mirroring still work while browsing');
}
for (const state of [{tool:'move',drag:{mode:'propmove'},dragPid:7},{tool:'belt',connectFrom:'inbox'},{tool:'dupe',dupe:{type:'prop'}}]) {
  const s=Object.assign(fixture(),state);
  s.onKey({key:'Escape',target:null});
  assert.equal(s.tool,'select','one Escape returns to browsing');
  assert.equal(s.drag,null); assert.equal(s.connectFrom,null); assert.equal(s.dupe,null);
  assert.equal(s.dragPid,null); assert.equal(s.closed,0,'cancel does not exit the editor');
  if(state.dragPid) assert.equal(s.releases,1,'cancel releases the captured pointer');
}
{
  const s=fixture(); s.tool='line'; s.buildGroup='workflow';
  s.root.querySelector=()=>({focus:()=>{s.focused=true;}});
  s.onKey({key:'/',target:null,preventDefault(){}});
  assert.equal(s.tool,'select'); assert.equal(s.buildGroup,'props'); assert.equal(s.focused,true);
}
{
  const tutorial=fs.readFileSync(require.resolve('../frontend/app/tutorial.js'),'utf8');
  const coachCode=tutorial.slice(tutorial.indexOf('function showCoach('),tutorial.indexOf('/* ---- the catalog:'));
  let marked=0;
  const s={active:false,seen:()=>false,document:{querySelector:()=>({})},markSeen:()=>marked++};
  vm.createContext(s); vm.runInContext(coachCode,s);
  for(const key of ['build','prop','belt','connector','wf-bay']) s.showCoach(key,null,'test');
  assert.equal(marked,0,'browsing and placement do not show or consume coach bubbles');
  const progress=[];
  Object.assign(s,{kitMode:false,WorldModel:{grantLabelForProp:()=>null},WF_COACH:{bay:'bay help'},tickBrief:key=>progress.push(key)});
  vm.runInContext(tutorial.slice(tutorial.indexOf('function onPropPlaced('),tutorial.indexOf('function onBeltPlaced(')),s);
  s.onPropPlaced('bay'); assert.deepEqual(progress,['build'],'quiet placement still records real progress');
}
console.log('refit-flow-polish: placement ownership, single Escape cancellation, pointer release, safe search and quiet progress PASS');
