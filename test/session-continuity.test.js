'use strict';
// Execute the shipped restore/admission seam against controlled transport order.
// Each seed runs multiple overlapping reads, a user turn, navigation, save/reload,
// and a failed read. Assertions describe user-state invariants, not source strings.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const A = require('./_assert');

async function campaign(root, seed) {
  const src = fs.readFileSync(root + '/chat.js', 'utf8');
  const requests = [], sessions = new Map();
  let saves = 0, paints = 0, saved;
  const w = { id: 'a', history: [{role:'user',content:'SECRET QUESTION',sourceRunId:'old'}] };
  const peer = { id:'b', history:[] }; sessions.set('a',w); sessions.set('b',peer);
  const context = vm.createContext({
    Date, WeakMap, Map, Promise, AbortController, setTimeout, clearTimeout,
    Workstreams:{get:id=>sessions.get(id)}, Channels:{isBusy:()=>false},
    App:{persist:()=>{saves++; saved=JSON.stringify([...sessions.values()]);}},
    fetch:(_url,opts)=>new Promise(resolve=>requests.push({resolve,signal:opts.signal})),
    renderHistory:()=>paints++, replayChannel(){}, syncStatus(){}, maybeEmptyState(){}, pinLoadedHistoryAfterLayout(){},
    log:{innerHTML:''}, activeWs:w, historyPinSeq:5, historyPinPending:0,
  });
  const merge = A.fnBody(src,'function mergeCanonicalHistory(local, turns)');
  const seam = src.slice(src.indexOf('  const historyLoads = new WeakMap();'), src.indexOf('\n  // swap the rendered conversation',src.indexOf('  const historyLoads = new WeakMap();')));
  assert.ok(seam.length>1000 && seam.length<12000, 'bounded production seam');
  vm.runInContext(merge+'\n'+seam+'\nthis.api={loadServerHistory,ensureHistoryReady,continuityDiagnostics};',context);
  const {api}=context;
  const reply = (index,turns,status=200)=>requests[index].resolve({ok:status===200,json:async()=>({turns})});
  const oldRows = [...w.history,{role:'assistant',content:'older read',sourceRunId:'old'}];
  const freshRows = [...w.history,{role:'assistant',content:'latest read',sourceRunId:'old'}];
  const first = api.loadServerHistory(w,5), second = api.loadServerHistory(w,5);
  let admitted = false;
  const wait = api.ensureHistoryReady(w,new AbortController().signal).then(()=>{admitted=true;});
  w.history.push({role:'user',content:'follow-up '+seed,sourceRunId:'new'});
  if (seed%2) context.activeWs=peer;
  if (seed%3) {reply(0,oldRows); assert.equal(await first,false);}
  await Promise.resolve(); assert.equal(admitted,false,'no inference admission before current history arrives');
  reply(1,freshRows); assert.equal(await second,true); await wait;
  if (!(seed%3)) {reply(0,oldRows);assert.equal(await first,false);}
  assert.deepEqual(Array.from(w.history,m=>m.content),['SECRET QUESTION','latest read','follow-up '+seed]);
  assert.equal(paints,seed%2?0:1,'only the current session paints after initial scroll pin ended');
  assert.equal(peer.history.length,0,'no cross-session writes');
  assert.equal(saves,1,'stale result cannot save');
  const restored=JSON.parse(saved).find(r=>r.id==='a');
  assert.deepEqual(restored.history,JSON.parse(JSON.stringify(w.history)),'round-trip keeps accepted order');
  const before=JSON.stringify(w.history);
  const failed=api.loadServerHistory(w,5); reply(2,[],503);assert.equal(await failed,false);
  await assert.rejects(api.ensureHistoryReady(w,new AbortController().signal),/history could not be restored/);
  assert.equal(JSON.stringify(w.history),before,'unavailable is not empty and cannot erase history');
  const retry=api.ensureHistoryReady(w,new AbortController().signal);reply(3,freshRows);await retry;
  const removed=api.loadServerHistory(w,5);sessions.delete('a');reply(4,freshRows);assert.equal(await removed,false);
  assert.equal(saves,1,'removed session cannot be persisted by late response');
  sessions.set('a',w);
  const clear=api.loadServerHistory(w,5); w.history=[];reply(5,freshRows);assert.equal(await clear,false);
  assert.equal(w.history.length,0,'in-flight read cannot undo a clear');
  const malformed=api.loadServerHistory(w,5);reply(6,null);assert.equal(await malformed,false,'malformed success is unknown');
  const events=api.continuityDiagnostics();
  assert.ok(events.length<=64);
  assert.ok(!JSON.stringify(events).includes('SECRET'),'diagnostics contain no conversation text');
  events[0].event='mutated'; assert.notEqual(api.continuityDiagnostics()[0].event,'mutated','read-only snapshot');
  for(let n=0;n<70;n++) {const p=api.loadServerHistory(w,5);reply(7+n,[]);await p;}
  assert.equal(api.continuityDiagnostics().length,64,'bounded diagnostic history');
  const offset=requests.length;
  const older=api.loadServerHistory(w,5);
  const waiting=api.ensureHistoryReady(w,new AbortController().signal);
  const newer=api.loadServerHistory(w,5);
  reply(offset,oldRows);assert.equal(await older,false);
  reply(offset+1,freshRows);await newer;await waiting;
  assert.equal(w.history.at(-1).content,'latest read','waiting send follows a superseding reopen');
  const abort=new AbortController();abort.abort();
  await assert.rejects(api.ensureHistoryReady(w,abort.signal),/changed before sending/);
  const diagnosticSource=fs.readFileSync(root+'/diagnostics.js','utf8');
  context.Chat=api;
  vm.runInContext(A.fnBody(diagnosticSource,'function withSessionContinuity(text)'),context);
  const report=vm.runInContext("withSessionContinuity('build identity')",context);
  assert.ok(report.includes('history-loaded'));
  assert.ok(!report.includes('SECRET') && !report.includes('latest read'),'copied diagnostics omit prose');
  A.ok(true, root+' lifecycle sequence '+seed+' completed');
}
(async()=>{
  for(const root of ['frontend/app','website/app/app']) for(let seed=0;seed<24;seed++) await campaign(root,seed);
  A.report('session-continuity (48 lifecycle sequences, both shipped trees)');
})().catch(e=>{console.error(e);process.exitCode=1;});
