'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const A=require('./_assert');
const source=fs.readFileSync('frontend/app/world.js','utf8');
const names=['curveAmount','overAmt','curvePoint','uncurvePoint'];
const make=Function('native',`${names.map(n=>A.fnBody(source,'function '+n+'(')).join('\n')}
 const window={__STARNET_NATIVE__:native},CRT={curve:.09,over:1.2},cv={width:1600,height:1200};
 const document={body:{classList:{contains:()=>false}}};return{curvePoint,uncurvePoint};`);
test('native scene keeps Retina coordinates and matching hit targets without barrel distortion',()=>{
 const view=make(true);
 for(const p of [{x:0,y:0},{x:800,y:600},{x:1599,y:1199},{x:390,y:440}]){
  assert.deepEqual(view.curvePoint(p),p);assert.deepEqual(view.uncurvePoint(p),p);
 }
 const browser=make(false),p={x:390,y:440},roundtrip=browser.uncurvePoint(browser.curvePoint(p));
 assert(Math.abs(roundtrip.x-p.x)<.01&&Math.abs(roundtrip.y-p.y)<.01,'browser CRT path and its hit mapping remain paired');
});
