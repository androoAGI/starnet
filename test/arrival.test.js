'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),A=require('./_assert');
const Arrival=require('../frontend/app/arrival');
assert.equal(Arrival.frame(23999).done,false);assert.equal(Arrival.frame(24000).done,true);
assert.equal(Arrival.frame(5999,true).done,false);assert.equal(Arrival.frame(6000,true).done,true);
assert.equal(Arrival.frame(NaN).t,0);assert.equal(Arrival.frame(-500).t,0);
for(let ms=0;ms<=25000;ms+=100){const f=Arrival.frame(ms);for(const k of ['gather','assemble','land','settle','body','darkness'])assert.ok(f[k]>=0&&f[k]<=1,k);assert.deepEqual(f,Arrival.frame(ms));}
let depth=0,calls=0;
const ctx=new Proxy({save(){depth++},restore(){depth--},createRadialGradient(){return{addColorStop(){}}}}, {get(o,k){return k in o?o[k]:(()=>{calls++})},set(o,k,v){if(k==='globalAlpha')assert.ok(v>=0&&v<=1);o[k]=v;return true}});
for(const reduced of [false,true])for(let elapsed=0;elapsed<=24000;elapsed+=100){Arrival.draw(ctx,{width:1280,height:720,x:640,y:390,scale:3,sprite:{},elapsed,reduced});assert.equal(depth,0);}
assert.ok(calls>1000);
// Exercise the actual world lifecycle, including stale timeout and double-skip paths.
const source=fs.readFileSync(require.resolve('../frontend/app/world.js'),'utf8');
const body=n=>A.fnBody(source,'function '+n+'(');
const create=Function('Arrival',`let arrivalScene=null,kindleArmed=true,kindleP=0,sparkAt=0,wakeDarkTarget=.92,awakeFrozen=true,camAnim=null,scale=1,panX=0,panY=0;let reduced=false,callbacks=0;const timers=[];const agent={px:30,py:40},cache={};const SPRITES={ready:true,drawBody(){}};const nodes=[];const document={createElement(){const n={remove(){this.removed=true},setAttribute(){},append(...children){this.children=children},getContext(){return{}}};nodes.push(n);return n},body:{appendChild(){}}};const performance={now:()=>100};const reduceMotion=()=>reduced,camCenterOn=()=>[3,10,20],camTweenTo=()=>{camAnim={}},setTimeout=f=>{timers.push(f);return timers.length},clearTimeout=()=>{};${body('cancelArrival')}\n${body('playArrival')}\n${body('setWakeProgress')}\nreturn {start:()=>playArrival(()=>callbacks++),skip:()=>arrivalScene.controls.children[1].onclick(),cancel:cancelArrival,fire:i=>timers[i](),state:()=>({callbacks,scene:!!arrivalScene,scale,camAnim,wakeDarkTarget}),reduce:()=>{reduced=true},progress:setWakeProgress};`);
let w=create(Arrival);assert.equal(w.start(),true);w.skip();w.fire(0);assert.equal(w.state().callbacks,1);w.progress(.1);assert.equal(w.state().wakeDarkTarget,.16);
w=create(Arrival);w.start();w.cancel();w.fire(0);assert.equal(w.state().callbacks,0);assert.equal(w.state().scene,false);
w=create(Arrival);w.reduce();w.start();assert.equal(w.state().scale,3);assert.equal(w.state().camAnim,null);w.fire(0);assert.equal(w.state().callbacks,1);
console.log('arrival: timeline, rendering, skip, cancellation, reduced motion, and interview lighting passed');
