'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('onboarding music schedules on the audio clock and never catches up a missed backlog',()=>{
 const timers=new Map(),notes=[];let id=0;
 const context={console,SFX:{ctx:{currentTime:10,state:'running'},env:(f,o)=>notes.push({f,...o})},setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:id=>timers.delete(id)};
 const source=fs.readFileSync('frontend/app/onboarding.js','utf8').replace('return { start, stop, isRunning, offerDeferred','return { audio: AU, start, stop, isRunning, offerDeferred');
 const api=vm.runInNewContext(source+';Onboarding',context);
 api.audio.start();assert.equal(notes.length,5);assert(notes.every(n=>n.when>0),'audio is scheduled ahead of playback');
 assert(Math.abs(notes[2].when-notes[0].when-.16)<.00001,'heartbeat timing uses audio offsets');
 context.SFX.ctx.currentTime=40;const fn=[...timers.values()][0];timers.clear();fn();
 assert.equal(notes.length,10,'a 30 second stall schedules one new beat/pad, not old music');
 api.audio.start();assert.equal(timers.size,1,'starting again cannot stack music schedulers');
 api.audio.stop();assert.equal(timers.size,0,'stop clears the scheduler');
 const count=notes.length;context.SFX.ctx.state='interrupted';api.audio.start();assert.equal(notes.length,count,'interrupted device never accumulates scheduled voices');api.audio.stop();
});
