'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const text=fs.readFileSync('frontend/app/glass-comms.js','utf8');
const start=text.indexOf('  function choose('),end=text.indexOf('  function open(',start);
assert(start>=0 && end>start);
const events=[],focus=[],rendered=[];
const source={value:'nova',dispatchEvent(e){events.push({type:e.type,bubbles:e.bubbles,value:this.value});}};
const context={source,Event:class{constructor(type,options){this.type=type;this.bubbles=options.bubbles;}},
  close:restore=>focus.push(restore),render:()=>rendered.push(source.value)};
vm.createContext(context);vm.runInContext(text.slice(start,end),context);
context.choose('nova');
assert.equal(events.length,0,'choosing the current agent cannot spuriously switch or create a session');
context.choose('atlas');
assert.deepEqual(events,[{type:'change',bubbles:true,value:'atlas'}],'new choice uses the existing native change pipeline');
assert.deepEqual(focus,[true,true]);
assert.deepEqual(rendered,['nova','atlas']);
console.log('glass-comms: same-agent no-op, canonical change event and focus return passed');
