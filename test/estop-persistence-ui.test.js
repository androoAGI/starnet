/* node test/estop-persistence-ui.test.js — the E-STOP UI distinguishes current-process aborts
   from durable restart protection using the exact /api/halt receipt fields. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const safetySrc = fs.readFileSync(path.join(root, 'frontend/app/safety.js'), 'utf8');
const harnessSrc = fs.readFileSync(path.join(root, 'frontend/app/harness.js'), 'utf8');

async function drive(receipt) {
  let click = null, aborted = 0, alarmed = 0;
  const notices = [];
  const button = {
    id: '', type: '', textContent: '', title: '',
    setAttribute() {},
    addEventListener(type, fn) { if (type === 'click') click = fn; }
  };
  const cluster = { firstChild: null, insertBefore() {} };
  const document = {
    readyState: 'complete',
    querySelector(sel) { return sel === '#topbar .tb-status' ? cluster : null; },
    getElementById() { return null; },
    createElement() { return button; },
    addEventListener() {}
  };
  const sandbox = {
    document,
    window: { addEventListener() {} },
    Harness: { haltAll: async () => receipt },
    Chat: { abort() { aborted++; } },
    StationUI: { notify(message, kind) { notices.push({ message, kind }); } },
    SFX: { alarm() { alarmed++; } }
  };
  vm.runInNewContext(safetySrc, sandbox, { filename: 'safety.js' });
  A.ok(typeof click === 'function', 'visible E-STOP click handler was wired');
  await click();
  return { notices, aborted, alarmed };
}

(async () => {
  const durable = await drive({ halted: 2, nightshiftHaltPersisted: true, cronHaltPersisted: true, loopsHaltPersisted: true });
  A.eq(durable.notices[0], { message: 'HALT — stopped 2 runs', kind: 'warn' },
    'all-true receipt reports the honest abort count without inventing a durability warning');
  A.eq(durable.aborted, 1, 'local COMMS stream still aborts after the authoritative receipt');

  const partial = await drive({ halted: 1, nightshiftHaltPersisted: false, cronHaltPersisted: true, loopsHaltPersisted: false });
  A.ok(/stopped 1 run now/.test(partial.notices[0].message),
    'partial failure still says the current process stopped now');
  A.ok(/restart protection failed for night shift, loops/.test(partial.notices[0].message),
    'partial failure names only subsystems whose durable writes failed');
  A.eq(partial.notices[0].kind, 'bad', 'restart persistence failure is presented as a fault, not routine warning chrome');
  A.eq(partial.alarmed, 1, 'the emergency alarm still fires on partial persistence failure');

  for (const field of ['nightshiftHaltPersisted', 'cronHaltPersisted', 'loopsHaltPersisted']) {
    A.ok(harnessSrc.includes(field + ': j.' + field), 'Harness preserves /api/halt receipt field ' + field);
  }
  A.ok(/halted:\s*n\('halted'\) \+ n\('cronAborted'\) \+ n\('beatAborted'\)/.test(harnessSrc),
    'Harness still totals every real abort source before returning the receipt');

  /* A FAILED E-STOP IS NOT AN EMPTY ONE. Both a 4xx/5xx and an unreachable sidecar used to arrive here
     as {halted: 0} — byte-identical to a clean stop of an idle station — and rendered "HALT — stopped 0
     runs" in routine `warn` chrome. Verified against a live station before the fix: HTTP 500 and a
     network failure BOTH produced exactly {msg: 'HALT — stopped 0 runs', kind: 'warn'} on the one
     control the Commander presses while money is being spent. */
  for (const [reason, label] of [['the sidecar answered HTTP 500', 'http error'], ['the sidecar was unreachable', 'network failure']]) {
    const dead = await drive({ ok: false, halted: 0, reason });
    A.ok(/^E-STOP FAILED/.test(dead.notices[0].message), 'a ' + label + ' is announced as a FAILED stop, not as a stop of nothing');
    A.ok(dead.notices[0].message.includes(reason), 'the ' + label + ' names why the stop could not be confirmed');
    A.ok(/may still be live/.test(dead.notices[0].message), 'the ' + label + ' warns the runs may still be running');
    A.ok(!/stopped 0 runs/.test(dead.notices[0].message), 'the ' + label + ' never claims a run count it cannot prove');
    A.eq(dead.notices[0].kind, 'bad', 'a ' + label + ' is presented as a fault, not routine warning chrome');
    A.eq(dead.aborted, 1, 'local COMMS stream is still aborted when the server never confirmed — that is when it matters most');
    A.eq(dead.alarmed, 1, 'the emergency alarm still fires when the stop failed');
  }

  // A receipt carrying no `ok` at all is legacy/simulated and must keep the old reading, so the
  // /api/halt contract stays additive rather than breaking every existing caller.
  const legacy = await drive({ halted: 3 });
  A.eq(legacy.notices[0], { message: 'HALT — stopped 3 runs', kind: 'warn' }, 'a receipt without ok is read exactly as before');

  A.ok(/if \(!r\.ok\) return \{ ok: false/.test(harnessSrc), 'Harness treats a non-2xx /api/halt as a failed stop rather than an empty one');

  A.report('estop-persistence-ui.test');
})().catch(err => { console.error(err); process.exit(1); });
