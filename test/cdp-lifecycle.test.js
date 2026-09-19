'use strict';
const assert=require('node:assert/strict');
(async()=>{
  const {CDP}=await import('../scripts/lib/cdp.mjs');
  const timers=new Set(), originalSet=global.setTimeout, originalClear=global.clearTimeout;
  const listeners=new Map(); let sent;
  const ws={addEventListener(k,fn){listeners.set(k,fn);},send(raw){sent=JSON.parse(raw);}};
  global.setTimeout=fn=>{const t={fn};timers.add(t);return t;};
  global.clearTimeout=t=>timers.delete(t);
  try {
    const c=new CDP(ws);
    const p=c.send('Runtime.evaluate');
    listeners.get('message')({data:JSON.stringify({id:sent.id,result:{value:1}})});
    assert.deepEqual(await p,{value:1}); assert.equal(timers.size,0,'resolved CDP requests must release timeout handles');
    const failure=c.send('Bad.method');
    listeners.get('message')({data:JSON.stringify({id:sent.id,error:{message:'refused'}})});
    await assert.rejects(failure,/refused/); assert.equal(timers.size,0);
    const pending=c.send('Page.navigate');
    listeners.get('close')(); await assert.rejects(pending,/closed/i);
    assert.equal(c.pending.size,0); assert.equal(timers.size,0);
    ws.send=()=>{throw new Error('send failed');};
    await assert.rejects(c.send('Page.navigate'),/send failed/);
    assert.equal(c.pending.size,0); assert.equal(timers.size,0);
    console.log('CDP lifecycle: success, protocol failure, disconnect and send failure release pending work PASS');
  } finally {global.setTimeout=originalSet;global.clearTimeout=originalClear;}
})().catch(e=>{console.error(e);process.exitCode=1;});
