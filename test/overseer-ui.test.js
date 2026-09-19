'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const rows = new Map([['planning', {id:'planning'}]]);
  let reconciled = 0, persisted = 0, timeout, fail = false, hang = false;
  const data = {threads:[{id:'research',parentStreamId:'planning',agentId:'custom_researcher'}],workers:[{runId:'w1',status:'done'}],reviews:[{reviewRunId:'r1',status:'done'}]};
  const context = {
    module:{exports:{}}, console:{debug(){}}, AbortController,
    setTimeout(fn){timeout=fn;return 1;}, clearTimeout(){},
    document:{addEventListener(){}, createElement(){throw new Error('No additional UI permitted');}},
    Workstreams:{generalId:()=> 'general',get:id=>rows.get(id),adopt:row=>{rows.set(row.id,row);return true;}},
    App:{persist(){persisted++;},refreshRail(){},openWorkstream(){throw new Error('Must not move focus');}},
    StationCommands:{async reconcile(){reconciled++;}},
    fetch:async (_url,options)=>{
      if(hang) return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('timeout'))));
      if(fail) throw new Error('offline');
      return {ok:true,json:async()=>data};
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../frontend/app/overseer.js'),'utf8'),context);
  const sync=context.module.exports;
  await sync.refresh();
  assert.equal(rows.get('research').agentId,'custom_researcher');
  assert.equal(persisted,1);assert.equal(reconciled,1);
  await sync.refresh();assert.equal(reconciled,1,'unchanged polling does not rebuild the transcript');
  fail=true;await sync.refresh();fail=false;await sync.refresh();
  assert.equal(reconciled,2,'reconnect reconciles even if worker state did not change');
  hang=true;const pending=sync.refresh();timeout();await pending;hang=false;await sync.refresh();
  assert.equal(reconciled,3,'a hung request times out and does not permanently block synchronization');
  console.log('overseer sync: existing sessions, no added UI/focus changes, recovery and timeout PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
