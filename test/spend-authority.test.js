'use strict';
const assert = require('node:assert/strict');
const { makeLedger } = require('../sidecar/ledger.js');
const { makeBudget } = require('../sidecar/budget.js');
const { loadBounded } = require('../sidecar/logbound.js');
const clock = {now:()=>100000};
const missing = Object.assign(new Error('missing'),{code:'ENOENT'});
for (const code of ['EACCES','EIO','EMFILE']) {
  const ledger = makeLedger({clock,io:{readAll(){throw Object.assign(new Error(code),{code});},append(){}}});
  for (const scope of ['agent','day','global']) {
    const budget=makeBudget({clock,ledger,caps:{[scope]:1}});
    assert.equal(budget.check('r','a',0).unknown,true,code+' cannot turn unknown spend into fresh headroom');
    assert.equal(budget.resume(scope),null,'resume cannot erase accounting uncertainty');
  }
  assert.equal(makeBudget({clock,ledger,caps:{}}).check('r','a',0),null,'user-work quotas remain opt-in');
  assert.equal(ledger.health().complete,false);
}
let fail = true;
const ledger=makeLedger({clock,io:{readAll(){return [];},append(){if(fail)throw new Error('disk full');}}});
ledger.record({runId:'r',usd:1});
assert.equal(ledger.totalUsd(),1,'failed append still retains observed spend in RAM');
assert.equal(ledger.health().durable,false);
fail=false; ledger.record({runId:'s',usd:1});
assert.equal(ledger.health().durable,false,'later successful append cannot repair the missing earlier row');
assert.equal(makeBudget({clock,ledger,caps:{day:5}}).check('t','a',0).unknown,true);
for(const code of ['EACCES','EIO']) {
  assert.throws(()=>loadBounded({strict:true,fs:{readFileSync(){throw Object.assign(new Error(code),{code});}}},'ledger',100));
}
assert.deepEqual(loadBounded({strict:true,fs:{readFileSync(){throw missing;}}},'ledger',100),[]);
assert.throws(()=>loadBounded({strict:true,fs:{readFileSync(p){return p.endsWith('.1')?'x'.repeat(110)+'\n':'{}\n';}}},'ledger',100),/truncat/i);
console.log('spend authority: unreadable history, configured scopes, opt-in policy, failed append, missing file and truncated history PASS');
// Admission durability is independent of whether the Commander configured a quota.
let starts=0, finishes=0;
const journal=makeLedger({clock,nextId:()=> 'entry-'+finishes,io:{readAll:()=>[],append(){},beginRun(){starts++;},finishRun(){finishes++;}}});
assert.equal(journal.beginRun('one','a'),true);assert.equal(journal.beginRun('one','a'),true);assert.equal(starts,1);
journal.record({runId:'one',usd:0.1});assert.equal(finishes,1);assert.equal(journal.all()[0].entryId,'entry-0');
const noReceipt=makeLedger({clock,io:{readAll:()=>[],append(){},beginRun(){throw Object.assign(Error('disk full'),{code:'ENOSPC'});}}});
assert.equal(makeBudget({clock,ledger:noReceipt,caps:{}}).check('r','a',0).unknown,true,'paid dispatch requires a durable receipt even without a dollar quota');
assert.equal(noReceipt.health().durable,false);
const unicodeFs={readFileSync(p){return p.endsWith('.1')?'éé\n':'éé\n';}};
assert.throws(()=>loadBounded({strict:true,fs:unicodeFs},'ledger',8),/truncat/i,'combined strict bound counts bytes');
console.log('spend admission: receipt failure, repeated checks, independent settlement identity and Unicode bounds PASS');
// An interrupted receipt remains unknown even with a recorded limit. Chosen caps refuse until explicit settlement;
// bounds are recovery suggestions, while the shipped soft rail preserves its authorized behavior.
{
  const appended=[], finished=[], begun=[];
  const io={readAll:()=>[{runId:'old',agentId:'a',usd:1,ts:99000}],unsettled:()=>[{runId:'x',agentId:'a',ts:50,runCapUsd:0.5}],
    append(e){appended.push(e);},finishRun(e){finished.push(e.runId);},beginRun(r){begun.push(r);}};
  const L=makeLedger({clock,io,nextId:()=> 'settle-'+appended.length});
  assert.equal(L.count(),1,'the readable rows are kept');assert.equal(L.totalUsd(),1);
  assert.deepEqual([L.health().complete,L.health().readError,L.health().unsettledRuns],[false,'UNSETTLED_SPEND',1]);
  const bounded=makeBudget({clock,ledger:L,caps:{day:5}}).check('r','a',0);
  assert.deepEqual([bounded.code,bounded.cause,bounded.countAsUsd],['spend_history_unavailable','unsettled',0.5],'a recorded limit does not prove the charge or waive the chosen cap');
  const capStop=makeBudget({clock,ledger:L,caps:{day:1.2}}).check('r','a',0);
  assert.ok(capStop&&capStop.scope==='day'&&capStop.unknown&&capStop.code==='spend_history_unavailable','a tighter chosen cap also refuses uncertain history: '+JSON.stringify(capStop));
  const open=makeLedger({clock,io:{readAll:()=>[{runId:'old',agentId:'a',usd:1,ts:99000}],unsettled:()=>[{runId:'x',agentId:'a',ts:50}],append(){}}});
  const blk=makeBudget({clock,ledger:open,caps:{day:5}}).check('r','a',0);
  assert.equal(blk.unknown,true,'a chosen cap stays fail-closed over a run with no bound');assert.equal(blk.cause,'unsettled');
  assert.equal(blk.exit,'press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER DAY to 0','...naming its one-click exit');
  assert.equal(makeBudget({clock,ledger:open,caps:{day:5},strictScope:()=>false}).check('s','a',0),null,'the soft shipped rail still proceeds');
  for(const bad of [NaN,-1,'0.3',Infinity,undefined]) assert.throws(()=>L.settleUnsettled('x',bad),e=>e.code==='bad_usd','refuses '+String(bad));
  assert.throws(()=>L.settleUnsettled('nope',0.3),e=>e.code==='not_unsettled','only a run found unsettled at boot');
  assert.throws(()=>L.settleUnsettled('s',0.3),e=>e.code==='not_unsettled','a run this process dispatched books itself');
  assert.equal(appended.length,0,'refusals book nothing');
  const row=L.settleUnsettled('x',0.3);
  assert.deepEqual([row.runId,row.agentId,row.usd,row.turns,row.ts,row.attested,row.model],['x','a',0.3,0,50,true,'(unknown)'],'one attested row at the dispatch time');
  assert.equal(row.attestedAs,'entered','the row says the Commander entered the charge');assert.deepEqual(appended[0],row,'the durable row carries the same attestation');
  assert.equal(appended.length,1);assert.deepEqual(finished,['x'],'the receipt is removed through finishRun');
  assert.deepEqual([L.health().complete,L.health().readError,L.health().unsettledRuns],[true,null,0],'history is complete again');
  assert.equal(L.unsettledRuns().length,0);assert.throws(()=>L.settleUnsettled('x',0.3),e=>e.code==='not_unsettled','never twice');
  assert.equal(makeBudget({clock,ledger:L,caps:{day:5}}).check('t','a',0),null,'the chosen cap works again');
}
{
  // a run counted at its per-run limit says so: the row never claims the Commander entered that figure
  const appended=[];
  const L=makeLedger({clock,io:{readAll:()=>[],unsettled:()=>[{runId:'y',agentId:'a',ts:60,runCapUsd:0.5},{runId:'z',agentId:'a',ts:61}],append(e){appended.push(e);},finishRun(){}}});
  const lim=L.settleUnsettled('y',0.5,'limit');
  assert.deepEqual([lim.usd,lim.attested,lim.attestedAs],[0.5,true,'limit']);assert.equal(appended[0].attestedAs,'limit');
  assert.equal(L.settleUnsettled('z',0.1,'bogus').attestedAs,'entered','an unknown mode is never recorded as a limit booking');
  const metered=L.record({runId:'m',usd:0.2});
  assert.ok(!('attested' in metered)&&!('attestedAs' in metered),'a metered row carries no attestation');
}
{
  // a run that is live in this process can never be settled from outside, even under a boot receipt's runId
  const L=makeLedger({clock,io:{readAll:()=>[],unsettled:()=>[{runId:'x',agentId:'a'}],append(){},beginRun(){},finishRun(){}}});
  L.beginRun('x','a');assert.throws(()=>L.settleUnsettled('x',1),e=>e.code==='not_unsettled');
  // a booked row for that run settles it exactly as the next boot would read it
  L.record({runId:'x',usd:0.2});assert.equal(L.unsettledRuns().length,0);assert.equal(L.health().complete,true);
  assert.equal(L.pendingRuns(),0,'a booked run is no longer pending');
}
{
  // a failed settlement write may have journaled: never offer a second booking; say a restart recovers it
  const L=makeLedger({clock,io:{readAll:()=>[],unsettled:()=>[{runId:'x',agentId:'a'}],append(){throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}}});
  assert.throws(()=>L.settleUnsettled('x',1),e=>e.code==='settle_write_failed');
  assert.equal(L.unsettledRuns().length,0);assert.equal(L.health().durable,false);
  assert.equal(makeBudget({clock,ledger:L,caps:{day:5}}).check('r','a',0).cause,'write','a write failure names restart as the fix');
  // real damage keeps no rows and offers nothing to settle
  const D=makeLedger({clock,io:{readAll(){throw Object.assign(new Error('bad'),{code:'SPEND_RECEIPT_CONFLICT'});},unsettled:()=>[{runId:'x'}],append(){}}});
  assert.deepEqual([D.count(),D.unsettledRuns().length,D.health().readError],[0,0,'SPEND_RECEIPT_CONFLICT']);
  assert.equal(makeBudget({clock,ledger:D,caps:{day:5}}).check('r','a',0).cause,'read');
}
{
  // the dispatch receipt names where the charge will show and the per-run limit the run started with — nothing else
  const receipts=[];
  const L=makeLedger({clock,io:{readAll:()=>[],append(){},beginRun(r){receipts.push(r);},finishRun(){}}});
  const B=makeBudget({clock,ledger:L,caps:{}});
  B.check('m1','a',0,0,null,()=>({provider:'openrouter',model:' test/m ',managed:true,runCapUsd:0.75,key:'sk-secret'}));
  B.check('m2','a',0,0,null,()=>({provider:'openrouter',runCapUsd:Infinity}));
  B.check('m3','a',0,0,null,()=>{throw new Error('meta boom');});
  assert.deepEqual(receipts[0],{runId:'m1',agentId:'a',ts:100000,provider:'openrouter',model:'test/m',managed:true,runCapUsd:0.75},'only the allowed fields reach disk');
  assert.deepEqual(receipts[1],{runId:'m2',agentId:'a',ts:100000,provider:'openrouter'},'an unlimited run claims no limit');
  assert.deepEqual(receipts[2],{runId:'m3',agentId:'a',ts:100000},'a throwing meta getter still begins the run');
  assert.equal(L.pendingRuns(),3);
  const soft=[];const S=makeLedger({clock,io:{readAll:()=>[],unsettled:()=>[{runId:'z'}],append(){},beginRun(r){soft.push(r);}}});
  makeBudget({clock,ledger:S,caps:{day:5},strictScope:()=>false}).check('s1','a',0,0,null,{provider:'p'});
  assert.equal(soft[0].provider,'p','the soft-unknown path forwards the receipt meta too');
}
console.log('spend recovery: kept rows, strict refusal, Commander settle, live-run guard, write failure, receipt meta PASS');

// Dispatch receipts preserve explicit BYOK as well as managed; absence is not false.
for (const managed of [true, false, undefined]) {
  let receipt;
  const L = makeLedger({clock,io:{readAll:()=>[],append(){},beginRun(r){receipt=JSON.parse(JSON.stringify(r));}}});
  assert.equal(L.beginRun('provenance','a',{provider:'test',managed}),true);
  assert.equal(receipt.managed,managed);
  assert.equal(Object.hasOwn(receipt,'managed'),typeof managed==='boolean');
  const reboot = makeLedger({clock,io:{readAll:()=>[],unsettled:()=>[receipt],append(){}}});
  assert.equal(reboot.unsettledRuns()[0].managed,managed);
  assert.equal(reboot.health().complete,false,'provenance never settles unknown spend');
}
console.log('spend receipt provenance: managed, BYOK and absent survive serialization/restart PASS');
// d688ea20: an unreadable record line is one unknown charge. Its suggested amount is not admission authority;
// every chosen cap refuses until settlement, regardless of the estimate or its timestamp.
// The settled row names the exact line it resolves, and history is whole again.
{
  const hash = 'a'.repeat(64);
  const L = makeLedger({ clock, io: { readAll() { return [{ runId: 'ok', agentId: 'agent', usd: 0.5, ts: 99999 }]; }, append() {},
    unsettled() { return [{ runId: 'damaged-aaaaaaaaaaaaaaaaaaaaaaaa', agentId: 'nova', kind: 'damaged', lineHash: hash, ts: 99000 }]; } } });
  assert.deepEqual([L.health().complete, L.health().readError, L.health().unsettledRuns, L.health().damagedLines], [false, 'UNSETTLED_SPEND', 1, 1]);
  const B = makeBudget({ clock, ledger: L, caps: { day: 5 } });
  const damagedStop = B.check('r2', 'agent', 0);
  assert.deepEqual([damagedStop.code, damagedStop.cause], ['spend_history_unavailable', 'damaged'], 'a damaged line refuses a chosen cap with its actual cause');
  assert.equal(B.status().day.usd, null, 'uncertain history never reports an exact total');
  assert.ok(Math.abs(B.status().day.estimatedUsd - 2.5) < 1e-9, 'known floor plus assumption remains separate recovery information');
  const tight = makeBudget({ clock, ledger: L, caps: { day: 2 } }).check('r2b', 'agent', 0);
  assert.ok(tight && tight.scope === 'day' && tight.unknown, 'an estimate cannot turn unknown history into an ordinary cap stop: ' + JSON.stringify(tight));
  const row = L.settleUnsettled('damaged-aaaaaaaaaaaaaaaaaaaaaaaa', 0.25);
  assert.deepEqual([row.attested, row.attestedAs, row.resolvesLine, row.ts, row.usd], [true, 'entered', hash, 99000, 0.25], 'the row names the line it resolves');
  assert.deepEqual([L.health().complete, L.health().damagedLines], [true, 0]);
  assert.equal(B.check('r3', 'agent', 0), null, 'known again: capped work proceeds');
  // a mix of a damaged line and an interrupted run with no limit: the run is the item that refuses
  const M = makeLedger({ clock, io: { readAll() { return []; }, append() {}, unsettled() { return [{ runId: 'damaged-b', kind: 'damaged', lineHash: 'b'.repeat(64) }, { runId: 'crashed', agentId: 'agent' }]; } } });
  assert.equal(makeBudget({ clock, ledger: M, caps: { day: 5 } }).check('r4', 'agent', 0).cause, 'unsettled');
  // resolvesLine is accepted only as a sha256 on an attested row
  const N = makeLedger({ clock, io: { readAll() { return []; }, append() {} } });
  assert.equal(N.record({ runId: 'plain', usd: 1, resolvesLine: hash }).resolvesLine, undefined, 'an ordinary row never claims to resolve a line');
  console.log('spend authority: a damaged record line is one unknown charge, named, settled once, resolved by hash PASS');
}
// The real loop refuses both damaged and interrupted unknown charges before any paid call, naming an explicit exit.
(async () => {
  const { runAgentLoop } = require('../sidecar/loop.js');
  const { makeCostEngine } = require('../sidecar/cost.js');
  const runOver = async (receipt) => {
    const out = [];
    let calls = 0;
    const provider = { priceOf: () => ({ in: 1, out: 1 }), contextLimit: () => 0, stream: async function* () { calls++; yield { type: 'done', finishReason: 'stop' }; } };
    const budget = makeBudget({ clock, ledger: makeLedger({ clock, io: { readAll: () => [], append() {}, unsettled: () => [receipt] } }), caps: { day: 5 } });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: (name, payload) => out.push({ name, payload }),
      cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), model: 'm', agentId: 'a', runId: 'r-' + receipt.runId,
      budget: { check: spent => budget.check('r-' + receipt.runId, 'a', spent) } });
    return { res, calls, err: out.find(e => e.name === 'agent.run.error') };
  };
  const damaged = await runOver({ runId: 'damaged-c', kind: 'damaged', lineHash: 'c'.repeat(64) });
  assert.equal(damaged.calls, 0, 'a damaged line cannot authorize a paid call under a chosen cap');
  assert.equal(damaged.res.failureCode, 'spend_history_unavailable');
  assert.match(damaged.err.payload.message, /line in the spend record is damaged/);
  const open = await runOver({ runId: 'crashed', agentId: 'a' });
  assert.equal(open.calls, 0, 'no paid call over a run nobody can count');
  assert.equal(open.res.failureCode, 'spend_history_unavailable');
  assert.ok(open.err && /^An earlier call has no settled charge/.test(open.err.payload.message) &&
    /Press COUNT AS \$2\.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER DAY to 0\.$/.test(open.err.payload.message), 'the refusal names its one-click exit: ' + (open.err && open.err.payload.message));
  console.log('spend authority: the loop refuses unknown charges and names the one-click exit before any paid call PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
