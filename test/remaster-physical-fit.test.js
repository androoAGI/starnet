'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const M=require('../frontend/app/worldmodel.js');
const context=vm.createContext({module:{exports:{}},PropRemaster:{isProjection:()=>true,ready:{then(){}}},U:{hash:()=>1,shade:c=>c}});
vm.runInContext(fs.readFileSync('frontend/app/propsprites.js','utf8'),context);
const P=context.module.exports,spec=P.spec('bridge_tacticaltable');
assert.equal(spec.w,5);assert.equal(spec.h,3);assert.equal(P.CATALOG.find(p=>p.id===spec.id).w,5);
M.setPropRules(t=>P.spec(t));
const original=M.defaultDoc();original.props=[{id:'table',t:spec.id,x:1,y:1,w:7,h:4}];
const st=M.deserialize(original),p=st.propById('table');
assert.deepEqual([p.x,p.y,p.w,p.h],[2,2,5,3]);
assert.equal(p.x+p.w/2,1+7/2,'horizontal centre preserved');
assert.equal(p.y+p.h,1+4,'floor contact preserved');
assert.equal(st.propAt(1,2),null,'former invisible side obstacle freed');
assert.equal(st.propAt(2,2),'table');
assert.deepEqual(M.deserialize(st.serialize()).serialize(),st.serialize(),'reload is idempotent');
assert(st.moveProp('table',1,0).ok);assert(st.undo().ok);assert.equal(st.propById('table').x,2);assert(st.redo().ok);assert.equal(st.propById('table').x,3);
const custom=M.defaultDoc();custom.props=[{id:'custom',t:spec.id,x:1,y:1,w:4,h:2}];
assert.equal(M.deserialize(custom).propById('custom').w,4,'custom placement unchanged');
M.setPropRules(null);assert.equal(M.deserialize(original).propById('table').w,7,'classic saves remain untouched without pack rules');
const manifest=JSON.parse(fs.readFileSync('frontend/assets/industrial/projection-correction/manifest.json'));
assert.deepEqual(manifest.props[spec.id].views.s.footprint,{w:5,h:3});
// Picking must honour transparent corners, open legs and the actual prepared frame.
const code=fs.readFileSync('frontend/app/propremaster.js','utf8');
const entry={spec:{footprint:{w:2,h:2}},frame:{x:-1,y:-3},body:{width:4,height:4},pickAlpha:Uint8Array.from([0,255,255,0,255,255,255,255,0,255,255,0,0,255,0,0])};
const scope={enabled:()=>true,entries:new Map([['table:s',entry]]),DENSITY:1};
vm.runInNewContext(code.slice(code.indexOf('  function hitTest('),code.indexOf('  return Object.freeze({ready'))+';this.pick=hitTest;',scope);
assert.equal(scope.pick('table','s',-1,-3,24,24),false,'transparent clipped corner is not selectable');
assert.equal(scope.pick('table','s',0,-3,24,24),true,'visible crown outside floor box is selectable');
assert.equal(scope.pick('table','s',1,0,24,24),false,'gap between feet is not selectable');
assert.equal(scope.pick('table','s',0,0,12,12),null,'custom footprint uses native picking fallback');
entry.lost=true;assert.equal(scope.pick('table','s',0,0,24,24),null,'lost cache falls back');
console.log('PASS: pack-scoped physical resize, saved centre/contact, freed tiles, undo/redo, reload, custom saves and alpha picking.');
// Selection bounds use rendered alpha, independently of the reserved floor tiles.
const spriteSource=fs.readFileSync('frontend/app/propsprites.js','utf8');
const selectionStart=spriteSource.indexOf('  const selectionMasks = new WeakMap();');
const selectionEnd=spriteSource.indexOf('  function hasOver(',selectionStart);
let reads=0;
const pixels=new Uint8ClampedArray(96*100*4);
for(let y=56;y<76;y++)for(let x=21;x<71;x++)pixels[(y*96+x)*4+3]=255;
pixels[3]=64; // glow must not extend the selection border
const mask={width:96,height:100,getContext:()=>({getImageData:()=>{reads++;return{data:pixels};}})};
const selectionScope={TILE:12,shadowMask:f=>f.empty?null:mask,surfaceLift:f=>f.mount?6:0};
vm.runInNewContext(spriteSource.slice(selectionStart,selectionEnd)+';this.bounds=selectionBounds;',selectionScope);
const bounds=f=>JSON.parse(JSON.stringify(selectionScope.bounds(f)));
assert.deepEqual(bounds({x:2,y:3,w:5,h:3}),{x:29,y:44,width:50,height:20},'opaque artwork excludes packing and glow');
assert.deepEqual(bounds({x:4,y:5,w:5,h:3,mount:true}),{x:53,y:62,width:50,height:20},'moving and mounting preserve the art offset');
assert.equal(reads,1,'repeated selection reuses the rendered-mask measurement');
assert.equal(bounds({empty:true}),null,'unavailable artwork falls back to tile selection');
console.log('PASS: selection follows visible alpha, translated/mounted art, cached measurement and unavailable-art fallback.');
// A real multi-room fixture must retain its existing placement/routing metadata
// through the remaster save path. Only the explicitly versioned table migration
// may change a placement; repeated loads must never drift coordinates.
const legacyLayout=require('./fixtures/prop-layout-geometry.json');
const legacyBytes=JSON.stringify(legacyLayout);
M.setPropRules(null);const nativeSave=M.deserialize(legacyLayout).serialize();
M.setPropRules(id=>P.spec(id));const upgradedSave=M.deserialize(nativeSave).serialize();
const nativeDoc=typeof nativeSave==='string'?JSON.parse(nativeSave):nativeSave;
const upgradedDoc=typeof upgradedSave==='string'?JSON.parse(upgradedSave):upgradedSave;
for(const key of ['rooms','order','belts','edges','meta'])assert.deepEqual(upgradedDoc[key],nativeDoc[key],'upgrade preserves '+key);
for(const before of nativeDoc.props){const after=upgradedDoc.props.find(p=>p.id===before.id);assert(after,'no saved prop disappears');if(before.t!=='bridge_tacticaltable')assert.deepEqual(after,before,'unchanged saved placement '+before.id);}
assert.deepEqual(M.deserialize(upgradedSave).serialize(),upgradedSave,'second load does not move or relabel anything');
assert.equal(JSON.stringify(legacyLayout),legacyBytes,'upgrade never mutates the source document');
M.setPropRules(null);
console.log('PASS: legacy multi-room save retains room, placement, routing and agent assignment metadata with an idempotent remaster load.');
