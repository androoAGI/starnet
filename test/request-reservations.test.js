'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {makeRequestReservations}=require('../sidecar/request-reservations');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'starnet-request-test-'));
 const deps={fs,path,workspaces:root,now:()=>1000};
 let calls=0,release; const wait=new Promise(r=>release=r);
 const args={scope:'principal:session',key:'one',body:{b:2,a:1},runId:'first'};
 const execute=async()=>{calls++;await wait;return {status:200,body:'exact result',headers:{}};};
 try {
  const ledger=makeRequestReservations(deps);
  const one=ledger.run(args,execute);const two=ledger.run({...args,body:{a:1,b:2},runId:'second'},execute);
  release();assert.deepEqual(await one,await two);assert.equal(calls,1);
  await assert.rejects(ledger.run({...args,body:{a:9}},execute),{code:'idempotency_conflict'});
  const restarted=makeRequestReservations(deps);assert.deepEqual(await restarted.run(args,execute),await one);assert.equal(calls,1);
  await restarted.run({...args,scope:'other'},execute);assert.equal(calls,2);
  let finish;const pending=ledger.run({...args,key:'orphan'},()=>new Promise(r=>finish=r));
  await new Promise(r=>setImmediate(r));
  await assert.rejects(makeRequestReservations(deps).run({...args,key:'orphan'},execute),{code:'request_interrupted'});
  finish({status:200,body:'orphan final'});await pending;
  fs.writeFileSync(path.join(root,'api-requests.json'),'{broken');
  await assert.rejects(makeRequestReservations(deps).run({...args,key:'new'},execute),{code:'reservation_store_unavailable'});
  assert.equal(calls,2,'corrupt/recovered reservation cannot dispatch');
  console.log('request-reservations: concurrent replay, canonical order, conflict, principal isolation, restart, orphan and corrupt-store checks passed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
