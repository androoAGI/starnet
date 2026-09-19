'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBugRegister } = require('../scripts/qa/bugs.mjs');
const { makeReconciler } = require('../scripts/qa/ledger-reconcile.mjs');
const { lifecycleErrors, escapeSummary, makeCoverageChecker } = require('../scripts/qa/bug-lifecycle.mjs');
const path = require('node:path');
const covered = { target: 'managed', state: 'covered', test: 'test/provider.openai-compatible.test.js', scenario: 'interrupted tool pair recovery', gate: 'fast' };
const coverage = JSON.stringify(Object.fromEntries(['adapters','entrypoints','displays','lifecycle'].map(axis => [axis, [{...covered, target: axis}]])));
function setup() {
  const files = new Map();
  const reg = makeBugRegister({ clock: {today: ()=>'2026-09-05'}, io: {
    listBugs: ()=>[...files].map(([file,text])=>({file,text})), writeBug: (file,text)=>files.set(file,text)
  }});
  const b = reg.create({title:'sample uses wrong provider',surface:'providers',origin:'customer',report:'public issue 6',affected:'0.10.13',family:'routing-identity',repro:'Select and run sample',evidence:'test/routing.sample-provider.e2e.test.js'}).bug;
  return {reg,b,files};
}
test('source fix cannot be closed without the four sibling dimensions and regression evidence', ()=>{
  const {reg,b,files}=setup(); const before=[...files.values()][0];
  assert.equal(reg.set(b.fingerprint,{status:'fixed',fix:'e33914cb2'}).ok,false);
  assert.equal([...files.values()][0],before,'refused closure leaves durable record untouched');
  const closed=reg.set(b.fingerprint,{status:'fixed',fix:'e33914cb2',coverage,regression:'Old sample missed roster provider; strict upstream failed before fix, passes after.'});
  assert.equal(closed.ok,true,closed.reason);
  const reread=reg.list()[0];
  assert.equal(reread.installer,'unverified'); assert.equal(reread.recovery,'unconfirmed');
  assert.equal(reread.sections['Sibling coverage'],coverage);
  assert.deepEqual(escapeSummary(reg.list()),{reports:1,sourceFixed:1,installerVerified:0,customerConfirmed:0,customerPersists:0,customerUnconfirmed:1});
});
test('installer and customer claims require independent evidence and survive later updates', ()=>{
  const {reg,b}=setup();
  assert.equal(reg.set(b.fingerprint,{status:'fixed',fix:'e33914cb2',coverage,regression:'before failed; after passed'}).ok,true);
  assert.equal(reg.set(b.fingerprint,{installer:'verified',installerVersion:'0.10.14'}).ok,false);
  assert.equal(reg.set(b.fingerprint,{recovery:'confirmed'}).ok,false);
  assert.equal(reg.set(b.fingerprint,{installer:'verified',installerVersion:'0.10.14',installerSha256:'a'.repeat(64),installerEvidence:'qa/installed/exact-artifact.json; selected sample survived restart',recovery:'confirmed',recoveryEvidence:'reporter confirmed sample on 2026-09-06'}).ok,true);
  assert.equal(reg.set(b.fingerprint,{lane:'followup'}).ok,true);
  const row=reg.list()[0]; assert.equal(row.installerSha256,'a'.repeat(64));assert.equal(row.recovery,'confirmed');
});
test('missing axis, fabricated coverage, and empty exemptions fail closed', ()=>{
  const {reg,b}=setup();
  for(const malformed of ['{}','not json',JSON.stringify({adapters:[{target:'Gemini',state:'covered'}]})]) {
    assert.equal(reg.set(b.fingerprint,{status:'fixed',fix:'e33914cb2',coverage:malformed,regression:'before/after'}).ok,false);
  }
  const axes=JSON.parse(coverage);axes.lifecycle=[{target:'restart',state:'blocked',reason:'no'}];
  assert.equal(reg.set(b.fingerprint,{status:'fixed',fix:'e33914cb2',coverage:JSON.stringify(axes),regression:'before/after'}).ok,false);
  axes.lifecycle[0].reason='Physical Mac unavailable; owner lane must provide hardware proof.';
  assert.equal(reg.set(b.fingerprint,{status:'fixed',fix:'e33914cb2',coverage:JSON.stringify(axes),regression:'before/after'}).ok,true);
});
test('legacy records remain valid without inventing historical recovery', ()=>{
  assert.deepEqual(lifecycleErrors({found:'2026-07-28',status:'fixed',fix:'abc'}),[]);
  assert.ok(lifecycleErrors({found:'2026-09-05',status:'fixed',origin:'unknown'}).length);
});
test('covered regression must exist in its declared exercised gate', ()=>{
  const check=makeCoverageChecker(path.resolve(__dirname,'..'));
  assert.equal(check(covered),'');
  assert.match(check({...covered,test:'test/not-a-real-escape.test.js'}),/missing/);
  assert.match(check({...covered,gate:'http'}),/not registered/);
  assert.match(check({...covered,test:'test/../package.json'}),/outside/);
});

test('customer journey campaign cannot drift outside mandatory fast/http gates', ()=>{
  const fs=require('node:fs'); const root=path.resolve(__dirname,'..');
  const read=name=>fs.readFileSync(path.join(root,'test',name+'.list'),'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
  const gates=new Set([...read('fast'),...read('http')]);
  const campaign=read('customer-journeys');
  assert.ok(campaign.length>0); assert.equal(new Set(campaign).size,campaign.length);
  for (const suite of ['test/session-continuity.test.js','test/session-reliability.e2e.test.js']) assert.ok(campaign.includes(suite), suite+' is a required session release guarantee');
  assert.match(fs.readFileSync(path.join(root,'.github/workflows/t0-clean-install-proof.yml'),'utf8'), /'session-reliability\.e2e\.test\.js'/, 'installed upgrade acceptance must run session continuity');
  for(const file of campaign) { assert.ok(gates.has(file),file+' must run in a mandatory gate'); assert.ok(fs.existsSync(path.join(root,file))); }
  for(const workflow of ['fast-gate.yml','release-train.yml']) {
    assert.match(fs.readFileSync(path.join(root,'.github/workflows',workflow),'utf8'),/^\s+run: npm run qa:customer-journeys\s*$/m,workflow+' must execute the customer campaign, not just register its tests');
  }
});

test('related fix prose cannot promote an unresolved customer report in reconciliation', ()=>{
  const {reg,b}=setup();
  const r=reg.set(b.fingerprint,{verdict:'Related commit 2b976f5f3 does NOT reproduce the customer disappearance. test/provider.openai-compatible.test.js passes for a different symptom.'});
  assert.equal(r.ok,true);
  const reconciler=makeReconciler({io:{isAncestor:()=>true,fileExists:()=>true,runTest:()=>({ok:true,code:0}),readFile:()=>'',searchCode:()=>[]}});
  const judged=reconciler.judgeRecord(reg.list()[0]);
  assert.equal(judged.verdict,'unverifiable');
  assert.deepEqual(judged.anchors.commits,[],'only the explicit fix field identifies the source repair');
});
