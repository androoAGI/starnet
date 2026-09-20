'use strict';
const assert=require('node:assert/strict');
const { _internals:{defaultPidAlive} }=require('../sidecar/workspace-owner.js');
const { _internals:{defaultPidAlive:cronPidAlive} }=require('../sidecar/cron-lock.js');
const kill=process.kill;
try {
  for(const code of ['EPERM','EACCES','EIO','ENOSYS',undefined]) {
    process.kill=()=>{throw Object.assign(new Error('probe unavailable'),code?{code}:{});};
    assert.equal(defaultPidAlive(process.pid+100000),true,'uncertain '+code+' must never authorize taking a workspace');
    assert.equal(cronPidAlive(process.pid+100000),true,'uncertain '+code+' must never authorize recovery or cron lock theft');
  }
  process.kill=()=>{throw Object.assign(new Error('not found'),{code:'ESRCH'});};
  assert.equal(defaultPidAlive(process.pid+100000),false,'OS proof of absence permits recovery');
  assert.equal(cronPidAlive(process.pid+100000),false,'OS proof of absence permits legacy lock recovery');
  process.kill=()=>true;
  assert.equal(defaultPidAlive(process.pid+100000),true);
} finally {process.kill=kill;}
console.log('workspace probe: unknown errors preserve ownership, ESRCH permits recovery PASS');
