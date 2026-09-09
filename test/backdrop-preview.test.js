'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('frontend/app/backdrop-preview.js','utf8');
function harness(options={}) {
 const jobs=[], timers=new Map();let worker, nextTimer=0, draws=0;
 class Worker {
  constructor(){worker=this;}
  postMessage(data){if(options.postFails)throw Error('worker unavailable');jobs.push(data);}
  terminate(){this.terminated=true;}
 }
 const context={URL,Worker:options.unsupported?undefined:Worker,OffscreenCanvas:class {},
  document:{currentScript:{src:'http://localhost/app/backdrop-preview.js'}},window:{devicePixelRatio:1},screen:{width:1280,height:900},matchMedia:()=>({matches:false}),
  setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id)};
 vm.createContext(context);vm.runInContext(source+';globalThis.preview=BackdropPreview;',context);
 return {preview:context.preview,jobs,timers,get worker(){return worker;},get draws(){return draws;},canvas:()=>({width:112,height:63,isConnected:true,getContext:()=>({clearRect(){},drawImage(){draws++;}})})};
}
(async()=>{
 let h=harness(), c=h.canvas(), result=h.preview.paint(c,'moon');
 assert.equal(h.jobs.length,1);assert.equal(h.jobs[0].width,112);
 let closed=0;const bitmap={close:()=>closed++};
 h.worker.onmessage({data:{token:h.jobs[0].token,bitmap}});
 assert.equal(await result,true);assert.equal(h.draws,1);assert.equal(closed,1);assert.equal(h.timers.size,0);
 c=h.canvas();result=h.preview.paint(c,'forest');c.isConnected=false;
 h.worker.onmessage({data:{token:h.jobs[1].token,bitmap}});
 assert.equal(await result,true);assert.equal(h.draws,1,'late reply cannot paint into a closed dialog');assert.equal(closed,2);
 result=h.preview.paint(h.canvas(),'moon');[...h.timers.values()][0]();assert.equal(await result,false,'timeout permits the original renderer fallback');
 h.worker.onmessage({data:{token:h.jobs[2].token,bitmap}});assert.equal(closed,3,'timed-out bitmap is released');assert.equal(h.draws,1);
 result=h.preview.paint(h.canvas(),'moon');h.worker.onerror({preventDefault(){}});assert.equal(await result,false);assert.equal(h.worker.terminated,true);
 assert.equal(await h.preview.paint(h.canvas(),'moon'),false,'failed worker is not recreated in a loop');
 h=harness({unsupported:true});assert.equal(await h.preview.paint(h.canvas(),'moon'),false);assert.equal(h.jobs.length,0);
 h=harness({postFails:true});assert.equal(await h.preview.paint(h.canvas(),'moon'),false);assert.equal(h.timers.size,0);
 // The worker uses the existing real sample entry points and bounds its scratch allocations.
 let ground=0,sky=0,imports=0,allocated=0;const sent=[];
 const workerContext={self:{postMessage:(value,transfer)=>sent.push({value,transfer})},
  importScripts:()=>imports++,Terrain:{GROUNDS:{moon:{}},paintSample:()=>ground++},SpaceBG:{paintSample:()=>sky++},
  OffscreenCanvas:class {constructor(){allocated++;}getContext(){return {};}transferToImageBitmap(){return bitmap;}}};
 vm.createContext(workerContext);vm.runInContext(fs.readFileSync('frontend/app/backdrop-preview-worker.js','utf8'),workerContext);
 workerContext.self.onmessage({data:{token:1,id:'moon',width:112,height:63}});
 workerContext.self.onmessage({data:{token:2,id:'void',width:112,height:63}});
 assert.equal(ground,1);assert.equal(sky,1);assert.equal(imports,1);assert.equal(sent[0].transfer[0],bitmap);
 workerContext.self.onmessage({data:{token:3,id:'moon',width:99999,height:63}});
 assert.equal(allocated,2);assert.equal(sent[2].value.failed,true);
 console.log('backdrop-preview: worker rendering, disposal, closed dialogs, timeout, unsupported/error fallback and bounded allocation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
