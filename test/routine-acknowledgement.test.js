'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../frontend/app/app.js'),'utf8');
const start=source.indexOf('      scheduleJob: (body) =>'),end=source.indexOf('\n      // G4 feature 2:',start);
assert.ok(start>0&&end>start);
let invalidations=0,reply;
const ctx=vm.createContext({Harness:{api:{post:async()=>{if(reply instanceof Error)throw reply;return reply;}}},QuerySpine:{invalidate:()=>invalidations++}});
vm.runInContext('globalThis.schedule=({'+source.slice(start,end)+'}).scheduleJob',ctx);
(async()=>{
 for(const j of [null,{},[],{ok:false},{ok:true},{duplicate:true},{ok:true,job:{}},{ok:true,error:'refused',job:{id:'bad'}}]){
  reply={ok:true,j};assert.equal((await ctx.schedule({name:'proof'})).ok,false,JSON.stringify(j));
 }
 reply={ok:false,j:{ok:true,job:{id:'bad'}}};assert.equal((await ctx.schedule({})).ok,false);
 reply=new Error('response lost');assert.equal((await ctx.schedule({})).ok,false);
 assert.equal(invalidations,0,'unknown outcomes never clear confirmed cache');
 for(const duplicate of [true,false]){reply={ok:true,j:{ok:true,duplicate,job:{id:'proven'}}};const r=await ctx.schedule({});assert.equal(r.ok,true);assert.equal(r.duplicate,duplicate);}
 assert.equal(invalidations,2);
 console.log('routine acknowledgements: malformed, refusal, missing identity, duplicate and verified create PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
