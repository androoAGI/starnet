import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, connectCDP, evalJS, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { SidecarFixture, allocatePort } = require('../test/helpers/sidecar-fixture.js');
const fixed = process.argv.includes('--expect-fixed');
const out = path.resolve('.dogfood/systemic-bugs');
fs.mkdirSync(out, { recursive: true });
const fixture = SidecarFixture.create({ timeoutMs: 20000, env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_DEFAULT_MODEL: 'test/model' } });
let browser, cdp;
try {
  materializeSeedWorkspace(fixture.workspace, 'test/model');
  await fixture.start();
  const port = await allocatePort();
  browser = launchChrome({ cdpPort: port, profileDir: path.join(out, 'browser') });
  cdp = await connectCDP(port);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url: fixture.baseUrl });
  assert.equal(await waitDevReady(cdp, evalJS, { url: fixture.baseUrl }), true);
  const result = await evalJS(cdp, `(async()=>{
    const original=window.fetch;
    const key='cabinet:write';
    await PermissionsStore.grant(key); await PermissionsStore.refresh();
    let release, entered;
    const held=new Promise(r=>entered=r);
    window.fetch=async(url,opts)=>{
      const response=await original(url,opts);
      if(String(url)==='/api/permissions' && (!opts?.method || opts.method==='GET')) {
        const bytes=await response.text(); entered();
        return new Promise(r=>release=()=>r(new Response(bytes,{status:response.status})));
      }
      return response;
    };
    const read=PermissionsStore.refresh(); await held;
    await PermissionsStore.revoke(key); release(); await read;
    const staleRead={cached:PermissionsStore.snapshot().grants.includes(key),actual:(await (await original('/api/permissions')).json()).grants.includes(key)};
    window.fetch=original;
    await PermissionsStore.setBypass(true);
    window.fetch=(url,opts)=>String(url)==='/api/permissions/bypass' ? Promise.resolve(new Response('{}',{status:200})) : original(url,opts);
    const malformed=await PermissionsStore.setBypass(false);
    window.fetch=original;
    const malformedBypass={cached:malformed.masterBypass,error:malformed.error,actual:(await (await original('/api/permissions')).json()).masterBypass};
    await PermissionsStore.setBypass(false);
    AutoJobStore.pinProposals([{title:'Systemic audit missing acknowledgement',cadenceId:'daily',prompt:'Audit only'}]);
    const id=AutoJobStore.pendingList().find(p=>p.title==='Systemic audit missing acknowledgement').id;
    window.fetch=(url,opts)=>String(url)==='/api/cron' && opts?.method==='POST' ? Promise.resolve(new Response('{}',{status:200})) : original(url,opts);
    const accepted=await AutoJobStore.acceptPending(id);
    window.fetch=original;
    const routine={accepted,preserved:AutoJobStore.pendingList().some(p=>p.id===id),actual:(await (await original('/api/cron')).json()).jobs.some(j=>j.name==='Systemic audit missing acknowledgement')};
    AutoJobStore.declinePending(id);
    let catalogCalls=0,failedCatalog=true;
    window.fetch=(url,opts)=>String(url)==='/api/skills' ? (catalogCalls++,Promise.resolve(new Response(JSON.stringify(failedCatalog?{}:{skills:[]}),{status:failedCatalog?503:200}))) : original(url,opts);
    Marketplace.open({mode:'deploy',tab:'recipes'});
    await new Promise(r=>setTimeout(r,350));
    const firstCalls=catalogCalls;
    Marketplace.close(); failedCatalog=false;
    Marketplace.open({mode:'deploy',tab:'recipes'});
    await new Promise(r=>setTimeout(r,350));
    const catalog={firstCalls,afterRecoveryCalls:catalogCalls,panelPresent:!!document.getElementById('mkt-dossier')};
    Marketplace.close();window.fetch=original;
    StationUI.openTerm('settings','permissions');
    for(let i=0;i<40&&!document.querySelector('[data-exec-policy-save]');i++)await new Promise(r=>setTimeout(r,100));
    const control=document.querySelector('[data-exec-policy-save]');
    if(!control)throw new Error('execution policy control missing');
    window.fetch=(url,opts)=>String(url)==='/api/execution/policy' ? Promise.resolve(new Response(JSON.stringify({ok:false,error:'AUDIT durable write refused'}),{status:200})) : original(url,opts);
    control.click();await new Promise(r=>setTimeout(r,1600));
    const execution={refusal:document.getElementById('toast-stack')?.textContent||''};
    window.fetch=original;StationUI.closeTerm('settings');
    return {staleRead,malformedBypass,routine,catalog,execution};
  })()`);
  result.exceptions = diagnostics.exceptions;
  fs.writeFileSync(path.join(out, fixed ? 'browser-after.json' : 'browser-before.json'), JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify(result, null, 2));
  if (fixed) {
    assert.equal(result.staleRead.cached, result.staleRead.actual);
    assert.equal(result.malformedBypass.cached, result.malformedBypass.actual);
    assert.ok(result.malformedBypass.error);
    assert.equal(result.routine.accepted.ok, false); assert.equal(result.routine.preserved, true);
    assert.equal(result.routine.actual, false); assert.deepEqual(result.exceptions, []);
    assert.ok(result.catalog.firstCalls>0); assert.ok(result.catalog.afterRecoveryCalls>result.catalog.firstCalls); assert.equal(result.catalog.panelPresent,true);
    assert.match(result.execution.refusal,/AUDIT durable write refused/);
  }
} finally {
  if (cdp) cdp.ws.close();
  if (browser) { const exited = new Promise(r=>browser.proc.once('exit',r)); browser.proc.kill(); await exited; }
  await fixture.dispose();
}
