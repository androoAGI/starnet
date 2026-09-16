'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(require.resolve('../scripts/qa/product-perfect/claims.mjs'),'utf8');
const start=source.indexOf('function observeCheck('),end=source.indexOf('\nfunction verifyCheck(',start);
const observe=Function('text',source.slice(start,end)+';return observeCheck;')(String);
const checks=[{kind:'contains',needle:'BoundaryMATCH'},{kind:'absent',needles:['boundarymatch','SENTRY.INIT(','missing']},{kind:'absent',needles:['ΟΣ','κ']}];
const boundary=Buffer.concat([Buffer.alloc(1024*1024-5,65),Buffer.from('BoundaryMATCH\nSentry.init(\nΟΣ κ'),Buffer.from([255,254])]);
for(const bytes of [Buffer.alloc(0),boundary,Buffer.from('ΟΣ κ')])for(const check of checks){
  const contents=bytes.toString('utf8');
  const expected=check.kind==='contains'?[contents.includes(check.needle)]:check.needles.map(n=>contents.toLowerCase().includes(n.toLowerCase()));
  assert.deepEqual(observe(bytes,check),expected);
}
console.log('qa-claims-streaming: OK (whole-buffer parity, binary and chunk-boundary needles)');
