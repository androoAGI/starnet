'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fn(src, name) {
  const match = src.match(new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, name + ' exists'); return match[0];
}
async function check(root) {
  const read = file => fs.readFileSync(path.join(__dirname, '..', root, file), 'utf8');
  const chat = read('chat.js');
  const streams = new Map(), notices = [], cards = [];
  let selected = 'original', pending = [], engaged = true;
  const context = {
    localStorage: { removeItem() {} }, setTimeout() {}, clearTimeout() {},
    fetch: async () => ({ok:true, json:async () => ({pending})}),
    Chat: {isBusy:()=>false, isComposerEngaged:()=>engaged, workshopReturn:(m,o)=>cards.push(o.sessionId)},
    StationUI: {notify:(text,kind,category,opts)=>notices.push({text,opts})},
    App: {openWorkstream:id=>{selected=id;}, persist() {}, refreshRail() {}},
    Workstreams: {get:id=>streams.get(id), adopt:w=>{streams.set(w.id,w);return w;}, markUnread:id=>{streams.get(id).lastReadAt=0;}}
  };
  const store = vm.runInNewContext(read('workshopstore.js')+';WorkshopStore', context);
  store.init({enabled:true,agentIds:()=>['agent']});
  store.onBuilt({runId:'live',manifest:{title:'Live build',files:[]}});
  assert.equal(selected,'original',root+': live delivery cannot interrupt composition');
  assert.equal(streams.get('workshop-live').lastReadAt,0);
  assert.equal(cards.length,0);
  assert.equal(notices.length,1); assert.equal(typeof notices[0].opts.onClick,'function');
  store.onBuilt({runId:'live',manifest:{title:'Duplicate',files:[]}});
  assert.equal(notices.length,1,'duplicate delivery stays quiet');
  notices[0].opts.onClick(); assert.equal(selected,'workshop-live','explicit review still navigates');
  selected='original'; pending=[{runId:'poll',title:'Polled build',files:[]}];
  await store._maybePresent(); assert.equal(selected,'original','attach poll preserves composer');
  await store.presentOnReturn(); assert.equal(selected,'original','return poll preserves composer');
  engaged=false; await store.presentOnReturn(); assert.equal(selected,'workshop-poll','idle reveal still works');
  assert.ok(cards.includes('workshop-poll'));

  const input={value:''}, composer={input,pendingAtts:[],document:{activeElement:null}};
  vm.runInNewContext(fn(chat,'isComposerEngaged')+';this.engaged=isComposerEngaged',composer);
  assert.equal(composer.engaged(),false);
  composer.document.activeElement=input; assert.equal(composer.engaged(),true,'empty focused input is protected');
  composer.document.activeElement=null; input.value=' \n'; assert.equal(composer.engaged(),true,'whitespace draft is protected');
  input.value=''; composer.pendingAtts=[{uploading:true}]; assert.equal(composer.engaged(),true,'pending upload is protected');
  composer.pendingAtts=[{id:'ready'}]; assert.equal(composer.engaged(),true,'ready attachment is protected');
  composer.pendingAtts=[];

  const ws={id:'target',runIds:['source']}, handoff={connectorId:'test',toolName:'read',runId:'source'};
  let saved=handoff, sends=0, opens=0, release, mode='up';
  const c={...composer,focusVersion:1,connectorContinuing:new Set(),
    Channels:{isBusy:()=>false}, Workstreams:{get:()=>ws,connectorHandoff:()=>saved,setConnectorHandoff:(id,h)=>{saved=h;}},
    App:{openWorkstream:()=>opens++,persist(){}}, StationUI:{notify(){}},
    Harness:{api:{get:()=>new Promise(resolve=>{release=()=>resolve({connectors:[{id:'test',state:mode,enabled:true,tools:['read']}]});}),post:async()=>{mode='up';}}},
    send:async()=>{sends++;ws.runIds.push('continued');}
  };
  vm.runInNewContext(fn(chat,'isComposerEngaged')+fn(chat,'continueConnectorTask')+';this.continueTask=continueConnectorTask',c);
  for (const change of ['draft','focus','upload','navigate','away-and-back']) {
    input.value=''; c.pendingAtts=[]; c.document.activeElement=null; saved=handoff;
    const result=c.continueTask(ws.id);
    if(change==='draft')input.value='keep this';
    if(change==='focus')c.document.activeElement=input;
    if(change==='upload')c.pendingAtts=[{uploading:true}];
    if(change==='navigate')c.focusVersion++;
    if(change==='away-and-back')c.focusVersion+=2;
    release(); assert.equal(await result,false,change+' cancels delayed continuation');
    assert.equal(saved,handoff); assert.equal(opens,0); assert.equal(sends,0);
  }
  input.value='';c.pendingAtts=[];c.document.activeElement=null;
  const first=c.continueTask(ws.id), duplicate=c.continueTask(ws.id);
  release(); assert.equal(await first,true); assert.equal(await duplicate,false);
  assert.equal(sends,1);assert.equal(opens,1);assert.equal(saved,null);
}
(async()=>{for(const root of ['frontend/app','website/app/app'])await check(root);console.log('session-typing-safety.test: PASS (desktop and website, delivery/attach/return, drafts/focus/uploads, delayed continuation and explicit navigation)');})().catch(e=>{console.error(e);process.exitCode=1;});
