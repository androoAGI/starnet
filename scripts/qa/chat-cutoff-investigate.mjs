// Reproduce browser EOF handling in a real isolated seeded station. No model calls.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { launchChrome, connectCDP, evalJS, sleep } from '../lib/cdp.mjs';
import { waitDevReady } from '../lib/seed.mjs';

const out = resolve('.dogfood/chat-cutoff');
mkdirSync(out, { recursive: true });
const port = 19419, cdpPort = 19420, url = `http://127.0.0.1:${port}/`;
for (const candidate of [port, cdpPort]) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(candidate, '127.0.0.1', () => server.close(resolve));
  });
}
const app = spawn(process.execPath, ['dev/seed.js', '--keep'], {
  env: { ...process.env, SKYNET_PORT: String(port), SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_OPENROUTER_KEY: 'sk-or-investigation-placeholder' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
let log = ''; app.stdout.on('data', d => log += d); app.stderr.on('data', d => log += d);
let browser, cdp;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    await sleep(500);
  }
  if (!ready) throw new Error('Sidecar failed to start: ' + log);
  browser = launchChrome({ cdpPort, profileDir: resolve(out, 'profile-' + Date.now()) }).proc;
  cdp = await connectCDP(cdpPort);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  if (!await waitDevReady(cdp, evalJS, { url })) throw new Error('Station did not reach game screen');
  const receipt = await evalJS(cdp, `(async () => {
    const realFetch = window.fetch;
    let mode = 'clean', serial = 0;
    const events = [];
    U.bus.on('workitem.delivered', e => events.push({name:'workitem.delivered', ...e}));
    window.fetch = async (input, opts) => {
      if (String(input) !== '/api/run') return realFetch(input, opts);
      const req = JSON.parse(opts.body);
      const runId = 'cutoff-investigation-' + (++serial);
      const rows = [
        {name:'agent.run.start',payload:{runId,agentId:'agent',model:'test/model'}},
        {name:'agent.token',payload:{runId,agentId:'agent',delta: mode === 'clean' ? 'The answer is complete.' : 'The answer stops in the middle of'}}
      ];
      if (mode === 'worker-only') rows.push({name:'agent.run.end',payload:{runId:runId+'-worker',agentId:'worker',reason:'done'}});
      if (!['eof','worker-only','reader-error'].includes(mode)) rows.push({name:'agent.run.end',payload:{runId,agentId:'agent',reason:mode==='cancelled'?'cancelled':'done',...(['length','no-newline'].includes(mode)?{finishReason:'length'}:mode==='policy'?{finishReason:'content_filter'}:{})}});
      let text = rows.map(e=>JSON.stringify(e)).join('\\n');
      if (mode !== 'no-newline') text += '\\n';
      const body = ['reader-error','after-end-error'].includes(mode) ? new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        setTimeout(() => controller.error(new TypeError('network error: socket closed')), 30);
      }}) : text;
      return new Response(body, {status:200, headers:{'Content-Type':'application/x-ndjson'}});
    };
    try {
      const results = [];
      for (const scenario of ['clean','length','eof','no-newline','worker-only','reader-error','cancelled','policy','after-end-error']) {
        mode = scenario;
        Harness.setModel('test/model'); // test-only identity is intentionally absent from the live catalog
        let transport;
        try { transport = await Harness.chat({messages:[{role:'user',content:'Explain this'}],agentId:'agent',isTask:true}); }
        catch (e) { transport = {error:e.message}; }
        const ws = Workstreams.create('Cutoff ' + scenario, {agentId:'agent',kind:'task'});
        Chat.load(ws);
        Harness.setModel('test/model');
        const before = events.length;
        await Chat.send('Explain this');
        const visible = document.getElementById('chat-log').innerText;
        const other = Workstreams.create('Replay neighbor', {agentId:'agent'});
        Chat.load(other); Chat.load(ws);
        results.push({scenario, wsId:ws.id, transport, history:ws.history, delivered:events.slice(before), visible,
          replay:document.getElementById('chat-log').innerText});
      }
      return {ready:document.querySelector('.screen.active')?.id,results};
    } finally {window.fetch = realFetch;}
  })()`);
  await sleep(1800);
  await cdp.send('Page.reload');
  await sleep(1000); // let navigation replace the old document before checking its ready flag
  if (!await waitDevReady(cdp, evalJS, { url })) throw new Error('Reload did not reach station');
  receipt.reloaded = await evalJS(cdp, `(${JSON.stringify(receipt.results.map(r=>({scenario:r.scenario,id:r.wsId})))})
    .map(r=>({scenario:r.scenario,history:Workstreams.get(r.id)?.history || []}))`);
  writeFileSync(resolve(out, 'live.json'), JSON.stringify(receipt, null, 2));
  for (const row of receipt.results) {
    assert.equal(row.delivered.length, ['clean','after-end-error'].includes(row.scenario) ? 1 : 0, row.scenario + ' delivery');
    if (['eof','worker-only','reader-error'].includes(row.scenario)) {
      assert.match(row.transport.error, /disconnected|socket closed/);
      assert.ok(row.history.some(m => m.error), 'interruption is recorded in history');
      assert.ok(row.history.some(m => m.content === 'The answer stops in the middle of'), 'partial answer survives');
      assert.ok(!row.visible.includes('RUN COMPLETE'), 'interrupted run is not complete');
      assert.ok(row.replay.includes('reply stream stopped'), 'session switch retains error');
      assert.ok(receipt.reloaded.find(r=>r.scenario===row.scenario).history.some(m=>m.error), 'reload retains error');
    }
    if (['length','no-newline'].includes(row.scenario)) assert.ok(row.visible.includes('CUT SHORT'));
  }
  console.log(JSON.stringify(receipt.results.map(r => ({scenario:r.scenario,text:r.transport.text,error:r.transport.error || null,endReason:r.transport.endReason,finishReason:r.transport.finishReason,delivered:r.delivered.length,history:r.history})), null, 2));
} finally {
  writeFileSync(resolve(out, 'boot.log'), log);
  if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.ws.close(); }
  if (browser) browser.kill();
  // seed.js forwards SIGTERM to the sidecar on platforms with signal support.
  if (app.exitCode === null && app.signalCode === null) {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], {stdio:'ignore',windowsHide:true});
  }
}
