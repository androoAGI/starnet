'use strict';
const assert = require('node:assert/strict');
(async () => {
  const { verifyAuthorityChecks } = await import('../scripts/qa/product-perfect/claims.mjs');
  const files = new Map([
    ['frontend/code.js', Buffer.from('Exact locator; ÄPFEL')],
    ['frontend/art.png', Buffer.concat([Buffer.from([0, 255]), Buffer.from('FORBIDDEN')])]
  ]);
  const requests = [
    { label: 'source', check: { kind: 'contains', path: 'frontend/code.js', needle: 'Exact locator' } },
    { label: 'case-sensitive', check: { kind: 'contains', path: 'frontend/code.js', needle: 'exact locator' } },
    { label: 'first', check: { kind: 'absent', paths: ['frontend'], needles: ['forbidden', 'äpfel'] } },
    { label: 'second', check: { kind: 'absent', paths: ['frontend'], needles: ['FORBIDDEN'] } },
    { label: 'empty', check: { kind: 'absent', paths: ['missing'], needles: ['x'] } }
  ];
  let reads = 0;
  const read = p => { reads++; return files.get(p); };
  const errors = [];
  verifyAuthorityChecks(requests, read, errors, [...files.keys()], true);
  assert.equal(reads, 2, 'overlapping checks read each file once, including binary assets');
  assert.equal(errors.length, 5);
  assert.ok(errors.some(e => e.includes('case-sensitive locator missing')));
  assert.ok(errors.some(e => e.includes('first absence escaped in frontend/code.js: "äpfel"')));
  assert.ok(errors.some(e => e.includes('first absence escaped in frontend/art.png')));
  assert.ok(errors.some(e => e.includes('second absence escaped in frontend/art.png')));
  const again = [];
  verifyAuthorityChecks(requests, read, again, [...files.keys()], true);
  assert.deepEqual(again, errors, 'cached immutable search results preserve every labelled failure');
  const changed = [];
  const mutable = Buffer.from('FORBIDDEN');
  const absent = [{ label: 'mutable', check: {kind:'absent',path:'file',needles:['forbidden']} }];
  verifyAuthorityChecks(absent, () => mutable, changed, ['file']);
  mutable.fill(0);
  const clean = [];
  verifyAuthorityChecks(absent, () => mutable, clean, ['file']);
  assert.equal(changed.length, 1); assert.equal(clean.length, 0, 'injected mutable readers never reuse cache');
  const missing = [];
  verifyAuthorityChecks(requests.slice(0, 2), () => { throw Error('missing blob'); }, missing, [...files.keys()]);
  assert.equal(missing.length, 2, 'read failure remains attributed to each requesting check');
  console.log('qa-claims-search-batch: binary scope, Unicode folding, exact locators, immutable caching and read failures PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
