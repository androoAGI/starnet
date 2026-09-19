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
