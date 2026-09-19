import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { SidecarFixture } = require('../test/helpers/sidecar-fixture.js');
const fixed = process.argv.includes('--expect-fixed');
const out = path.resolve('.dogfood/reliability-audit');
fs.mkdirSync(out, { recursive: true });
const fixture = SidecarFixture.create({ entry: path.resolve('test/helpers/save-read-fault-host.cjs'), timeoutMs: 20000,
  env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_DEFAULT_MODEL: 'test/model' } });
let browser, cdp;
const result = {};
try {
  materializeSeedWorkspace(fixture.workspace, 'test/model');
  await fixture.start();
  const port = await require('../test/helpers/sidecar-fixture.js').allocatePort();
  browser = launchChrome({ cdpPort: port, profileDir: path.join(out, fixed ? 'save-browser-after' : 'save-browser-before') });
  cdp = await connectCDP(port);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url: fixture.baseUrl });
  assert.equal(await waitDevReady(cdp, evalJS, { url: fixture.baseUrl }), true);
  await evalJS(cdp, 'CloudSave.flush({force:true})');
  result.stalledReply = await evalJS(cdp, `(async()=>{
    const original=window.fetch;
    let release; let signal;
    window.fetch=(url,opts)=>String(url).startsWith('/api/save') && opts?.method==='POST'
      ? (signal=opts.signal,Promise.resolve({ok:true,status:200,json:()=>new Promise(r=>release=r)})) : original(url,opts);
    CloudSave.push(Save.load());
    const attempt=CloudSave.flush({force:true});
    let timer;
    const outcome=await Promise.race([attempt,new Promise(r=>timer=setTimeout(()=>r('still-pending'),16000))]);
    clearTimeout(timer);
    const aborted=!!signal?.aborted;
    release({ok:true}); await attempt;
    window.fetch=original; await CloudSave.flush({force:true});
    return {outcome,aborted};
  })()`);
  result.unprovenReplies = await evalJS(cdp, `(async()=>{
    const original=window.fetch; const rows=[];
    for(const body of ['{}','not-json','{"ok":false,"error":"disk full"}']) {
      window.fetch=(url,opts)=>String(url).startsWith('/api/save') && opts?.method==='POST'
        ? Promise.resolve(new Response(body,{status:200})) : original(url,opts);
      CloudSave.push(Save.load());
      rows.push({body,confirmed:await CloudSave.flush({force:true})});
    }
    window.fetch=original; await CloudSave.flush({force:true});
    for(const body of ['{}','{"error":"unavailable"}','{"save":{"broken":true}}']) {
      window.fetch=(url,opts)=>String(url).startsWith('/api/save') && (!opts || !opts.method)
        ? Promise.resolve(new Response(body,{status:200})) : original(url,opts);
      const r=await CloudSave.reconcile(null);
      rows.push({body,unknown:CloudSave.isUnknownSentinel(r),empty:r===null});
    }
    window.fetch=original; return rows;
  })()`);
  result.staleAdoption = await evalJS(cdp, `(async()=>{
    const prior=localStorage.getItem('starnet.save'); const remote=await CloudSave.pull();
    const stale={...remote,updatedAt:1,_saveRevision:Math.max(0,(remote._saveRevision||1)-1)};
    localStorage.setItem('starnet.save',JSON.stringify(stale));
    const original=Storage.prototype.setItem;
    Storage.prototype.setItem=function(k,v){if(k==='starnet.save')throw new DOMException('quota','QuotaExceededError');return original.call(this,k,v);};
    let result;
    try { await CloudSave.reconcile(stale); result={expected:stale._saveRevision,actual:CloudSave.revision()}; }
    finally {Storage.prototype.setItem=original;localStorage.setItem('starnet.save',prior);}
    await CloudSave.reconcile(Save.load());return result;
  })()`);
  const main = path.join(fixture.workspace, 'agent.save.json');
  const control = path.join(fixture.workspace, 'save-read-fault.json');
  const bytes = fs.readFileSync(main, 'utf8');
  fs.writeFileSync(control, JSON.stringify({ file: 'agent.save.json' }));
  result.primary = await fixture.json('GET', '/api/save');
  // Inspect only public outcome, not the token or entire seeded save.
  result.primary = { status: result.primary.status, unreadable: result.primary.body.unreadable, empty: result.primary.body.save === null };
  result.browser = await evalJS(cdp, `(async()=>{const r=await CloudSave.reconcile(null);return {unknown:CloudSave.isUnknownSentinel(r),empty:r===null,outcome:CloudSave.pullOutcome()};})()`);
  if (fixed) {
    await evalJS(cdp, "localStorage.removeItem('starnet.save')");
    await cdp.send('Page.reload');
    for (let i = 0; i < 30; i++) {
      result.recoveryScreen = await evalJS(cdp, `({active:document.getElementById('screen-unreachable')?.classList.contains('active'),text:document.getElementById('unreachable-code')?.textContent})`).catch(() => ({}));
      if (result.recoveryScreen.active) break;
      await sleep(500);
    }
    assert.equal(result.recoveryScreen.active, true);
    assert.match(result.recoveryScreen.text, /SAVE-READ/);
  }
  fs.unlinkSync(control);
  if (fixed) {
    await evalJS(cdp, "document.getElementById('btn-unreachable-retry').click()");
    result.retryResumedStation = await waitDevReady(cdp, evalJS, { url: fixture.baseUrl });
    assert.equal(result.retryResumedStation, true);
    // A readable remote cannot be adopted if the cache write itself fails. Keep a truthful
    // recovery state and preserve the actual browser cache (prototype injection, restored).
    result.cacheAdoption = await evalJS(cdp, `(async()=>{
      const read=localStorage.getItem('starnet.save'); const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(k,v){if(k==='starnet.save')throw new DOMException('quota','QuotaExceededError');return original.call(this,k,v);};
      // Make Save.load fail too: an existing valid cache would otherwise mask failed adoption.
      const load=Save.load; Save.load=()=>null;
      try {const r=await CloudSave.reconcile(null);return {unknown:CloudSave.isUnknownSentinel(r),cacheUnchanged:localStorage.getItem('starnet.save')===read};}
      finally {Storage.prototype.setItem=original;Save.load=load;}
    })()`);
    assert.equal(result.cacheAdoption.unknown, true); assert.equal(result.cacheAdoption.cacheUnchanged, true);
  }
  result.primaryRecovered = (await fixture.json('GET', '/api/save')).body.save.agent.name;
  // A different record avoids any browser autosave interference during the backup-only case.
  const doc = { schema: 'starnet.save', version: 5, updatedAt: 100, agent: { id: 'audit', name: 'RETAIN ME' } };
  await fixture.json('POST', '/api/save', doc);
  const audit = path.join(fixture.workspace, 'audit.save.json');
  fs.renameSync(audit, audit + '.bak');
  fs.writeFileSync(control, JSON.stringify({ file: 'audit.save.json.bak' }));
  result.backupRead = (await fixture.json('GET', '/api/save?agent=audit')).status;
  result.backupWrite = (await fixture.json('POST', '/api/save', { ...doc, updatedAt: 200, agent: { id: 'audit', name: 'EMPTY REPLACEMENT' } })).body;
  fs.unlinkSync(control);
  await fixture.restart();
  const afterRestart = (await fixture.json('GET', '/api/save?agent=audit')).body;
  result.afterRestart = { name: afterRestart.save?.agent?.name, recovery: afterRestart.recovery?.kind };
  result.originalPrimaryRetained = fs.readFileSync(main, 'utf8') === bytes;
  result.exceptions = diagnostics.exceptions;
  fs.writeFileSync(path.join(out, fixed ? 'save-live-after.json' : 'save-live-before.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (fixed) {
    assert.equal(result.primary.status, 503); assert.equal(result.browser.unknown, true);
    assert.equal(result.backupRead, 503); assert.equal(result.backupWrite.ok, false);
    assert.equal(result.afterRestart.name, 'RETAIN ME'); assert.equal(result.afterRestart.recovery, 'recovered');
    assert.deepEqual(result.exceptions, []);
    assert.equal(result.staleAdoption.actual, result.staleAdoption.expected);
    assert.equal(result.stalledReply.outcome, false); assert.equal(result.stalledReply.aborted, true);
    for (const row of result.unprovenReplies) {
      if ('confirmed' in row) assert.equal(row.confirmed, false);
      else assert.equal(row.unknown, true);
    }
  }
} finally {
  if (cdp) cdp.ws.close();
  if (browser) { const exited = new Promise(resolve => browser.proc.once('exit', resolve)); browser.proc.kill(); await exited; }
  await fixture.dispose();
}
