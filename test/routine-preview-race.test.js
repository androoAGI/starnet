'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// the preview posts through the production Harness.api (truthful acks): its fetch is the only fake
const {harnessApi,answer}=require('./helpers/harness-api.js');
const source=fs.readFileSync(require('node:path').join(__dirname,'../frontend/app/windows/routines.js'),'utf8');
const start=source.indexOf('    function wirePreview('),end=source.indexOf('\n    const schedInp',start);
assert.ok(start>0&&end>start);
let handler,reply,timerId=0;
const timers=new Map();
const context=vm.createContext({AbortController,Date,Number,Array,String,
  setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  deviceTz:()=> 'UTC',Harness:{api:harnessApi(()=>reply)},esc:String,wallClock:String,fmtRel:()=> 'relative'});
vm.runInContext(source.slice(start,end)+';globalThis.wire=wirePreview;',context);
const input={value:'',addEventListener:(event,fn)=>{handler=fn;}},preview={textContent:'',innerHTML:'',isConnected:true};
context.wire(input,preview);
const type=value=>{input.value=value;handler();const t=[...timers].find(([,v])=>v.ms===300);if(t){timers.delete(t[0]);return t[1].fn();}};
const response=next=>answer(200,{ok:true,next});
(async()=>{
 let release;reply=new Promise(r=>release=r);const old=type('every 10m');
 reply=Promise.resolve(response(['2030-01-01T00:20:00Z']));await type('every 20m');
 release(response(['2030-01-01T00:10:00Z']));await old;
 assert.match(preview.innerHTML,/00:20/);assert.doesNotMatch(preview.innerHTML,/00:10/);
 reply=Promise.reject(new Error('offline'));await type('every 30m');assert.match(preview.textContent,/Could not check.*retry/);
 reply=Promise.resolve(answer(200,{ok:true}));await type('every 40m');assert.match(preview.textContent,/Could not check/);
 // a refusal is the station's answer: its own reason, or the gate's sentence, never 'unrecognized schedule'
 reply=Promise.resolve(answer(400,{ok:false,error:'bad schedule: every 0m'}));await type('every 0m');assert.match(preview.innerHTML,/bad schedule: every 0m/);
 reply=Promise.resolve(answer(403,'forbidden token',{'X-StarNet-Code':'token_stale'}));await type('every 45m');assert.match(preview.innerHTML,/station restarted/);assert.doesNotMatch(preview.innerHTML,/unrecognized/);
 reply=new Promise(r=>release=r);const cleared=type('every 50m');type('');release(response(['2030-01-01T00:50:00Z']));await cleared;assert.equal(preview.textContent,'');
 reply=Promise.resolve(response(['2030-01-01T01:00:00Z']));await type('every 60m');assert.match(preview.innerHTML,/01:00/);
 assert.equal(timers.size,0,'all timeout timers are released');
 console.log('routine-preview-race: PASS (stale, cleared, failed, malformed, refused and recovered previews)');
})().catch(e=>{console.error(e);process.exitCode=1;});
