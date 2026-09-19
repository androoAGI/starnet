import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, connectCDP, evalJS, collectDiagnostics } from "../../../scripts/lib/cdp.mjs";
import { materializeSeedWorkspace, waitDevReady } from "../../../scripts/lib/seed.mjs";
const require = createRequire(import.meta.url);
const { SidecarFixture, allocatePort } = require("../../../test/helpers/sidecar-fixture.js");
const fixed = process.argv.includes('--expect-fixed');
const out = path.resolve('.dogfood/systemic-bugs');
fs.mkdirSync(out, { recursive: true });
const fixture = SidecarFixture.create({ timeoutMs: 20000, env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_DEFAULT_MODEL: 'test/model' } });
let browser, cdp;
try {
  materializeSeedWorkspace(fixture.workspace, 'test/model');
  await fixture.start();
  const port = await allocatePort();
  browser = launchChrome({ cdpPort: port, profileDir: path.join(out, 'browser-timeouts') });
  cdp = await connectCDP(port);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url: fixture.baseUrl });
  assert.equal(await waitDevReady(cdp, evalJS, { url: fixture.baseUrl }), true);

  const result = await evalJS(cdp, `(async()=>{
    const original=window.fetch,rows=[];
    try {for(const phase of ['headers','body'])for(const verb of ['get','post','del']){
      let observed;
      window.fetch=(url,opts)=>String(url)==='/api/audit-held-request' ? (observed=opts.signal,phase==='headers'?new Promise(()=>{}):Promise.resolve({ok:true,status:200,json:()=>new Promise(()=>{})})) : original(url,opts);
      const started=performance.now();let error='';try{if(verb==='post')await Harness.api.post('/api/audit-held-request',{}, {timeoutMs:60});else await Harness.api[verb]('/api/audit-held-request',{timeoutMs:60});}catch(e){error=e.message;}
      rows.push({phase,verb,error,aborted:observed.aborted,elapsed:Math.round(performance.now()-started)});
    }}finally{window.fetch=original;}return rows;
  })()`);
  for(const r of result){assert.ok(r.error);assert.equal(r.aborted,true);assert.ok(r.elapsed<5000);}
  assert.deepEqual(diagnostics.exceptions,[]);
  fs.writeFileSync(path.join(out,'browser-timeouts.json'),JSON.stringify({rows:result,exceptions:diagnostics.exceptions},null,2)+'\n');
  console.log('Live browser finite API deadlines: six held-header/body scenarios PASS');
} finally {
  if (cdp) cdp.ws.close();
  if (browser) { const exited = new Promise(r=>browser.proc.once('exit',r)); browser.proc.kill(); await exited; }
  await fixture.dispose();
}
