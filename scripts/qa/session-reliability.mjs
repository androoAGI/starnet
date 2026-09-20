// Real seeded browser lifecycle campaign. Transport faults are injected at fetch;
// persistence and restart use the production sidecar. No customer data or paid calls.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { allocatePort, SidecarFixture } from '../../test/helpers/sidecar-fixture.js';
import { launchChrome, connectCDP, evalJS, sleep } from '../lib/cdp.mjs';
import { waitDevReady } from '../lib/seed.mjs';

const out = resolve('.dogfood/session-reliability');
mkdirSync(out, { recursive: true });
// Each invocation owns a workspace; reuse it only for this campaign's restart.
const seedWorkspace = mkdtempSync(resolve(out, 'workspace-'));
const port = await allocatePort(), cdpPort = await allocatePort();
const url = `http://127.0.0.1:${port}/`;
let app, browser, cdp, log = '';
const installedRoot = process.env.STARNET_SESSION_INSTALLED_ROOT;
const installed = installedRoot ? SidecarFixture.create({entry:resolve(installedRoot,'sidecar/index.js'),portAllocator:async()=>port,
  env:{SKYNET_DEV:'1',SKYNET_FULL_ACCESS:'1',SKYNET_DEFAULT_MODEL:'test/model',SKYNET_OPENROUTER_KEY:'sk-or-session-fixture'}}) : null;
if (installed) {
  cpSync(resolve('dev/fixtures/seed-workspace'),installed.workspace,{recursive:true});
  const file=resolve(installed.workspace,'agent.save.json'), envelope=JSON.parse(readFileSync(file,'utf8'));
  envelope.updatedAt=envelope.savedAt=envelope.doc.updatedAt=Date.now(); envelope.doc.agent.model='test/model';
  writeFileSync(file,JSON.stringify(envelope));
}
async function boot() {
  if (installed) { await installed.start(); return; }
  app = spawn(process.execPath, ['dev/seed.js', '--keep', '--workspace', seedWorkspace], {
    env: { ...process.env, SKYNET_PORT: String(port), SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_OPENROUTER_KEY: 'sk-or-session-fixture' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  app.stdout.on('data', d => log += d); app.stderr.on('data', d => log += d);
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error('Seed exited: ' + log);
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('Seed did not start: ' + log);
}
async function stop() {
  if (installed) { log += installed.output(); await installed.stop(); return; }
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  const exited = new Promise(r => app.once('exit', r));
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await new Promise(r => killer.once('exit', r));
  } else app.kill('SIGTERM');
  await Promise.race([exited, sleep(3000)]);
}
async function page() {
  await cdp.send('Page.navigate', { url });
  await sleep(500);
  assert.ok(await waitDevReady(cdp, evalJS, { url }), 'station becomes usable');
}
try {
  await boot();
  browser = launchChrome({ cdpPort, profileDir: resolve(out, 'profile-' + Date.now()) }).proc;
  cdp = await connectCDP(cdpPort);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await page();
  const result = await evalJS(cdp, `(${async function campaign() {
    const realFetch = window.fetch, reads = [], requests = [];
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const a = Workstreams.create('Reliability A', { agentId: 'agent' });
    const b = Workstreams.create('Reliability B', { agentId: 'agent', activate: false });
    a.history = [{role:'user',content:'Remember the launch code: ORBIT-17',sourceRunId:'seed-run'},
      {role:'assistant',content:'I have the launch code.',sourceRunId:'seed-run'}];
    const canonical = a.history.concat({role:'user',content:'The destination is Europa.',sourceRunId:'remote-run'},
      {role:'assistant',content:'Europa is the destination.',sourceRunId:'remote-run'});
    let serial = 0, offline = false, truncated = false, saveOffline = false;
    window.fetch = async (input, opts) => {
      const u = String(input);
      if (u === '/api/save' && opts?.method === 'POST' && saveOffline) return new Response('',{status:503});
      if (u.startsWith('/api/transcript?') && new URL(u, location.href).searchParams.get('stream') === a.id) {
        if (offline) return new Response('', {status:503});
        return new Promise(resolve => reads.push(turns => resolve(new Response(JSON.stringify({turns}), {headers:{'Content-Type':'application/json'}}))));
      }
      if (u === '/api/run') {
        const body = JSON.parse(opts.body); requests.push(body);
        const runId = 'reliability-' + (++serial);
        const rows = [
          {name:'agent.run.start',payload:{runId,agentId:'agent',model:'test/model'}},
          {name:'agent.token',payload:{runId,agentId:'agent',delta:'Continuity checked.'}},
          {name:'agent.run.end',payload:{runId,agentId:'agent',reason:'done'}}
        ];
        if (truncated) rows.pop();
        return new Response(rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
      }
      return realFetch(input, opts);
    };
    try {
      Workstreams.switch(a.id); Chat.load(a);
      await delay(200); // allow the initial scroll pin to finish before history arrives
      reads.shift()(canonical); await delay(150);
      const delayedVisible = document.getElementById('chat-log').innerText.includes('Europa is the destination.');
      // Reopen against a newer server transcript and send before that read resolves.
      Workstreams.switch(b.id); Chat.load(b);
      Workstreams.switch(a.id); Chat.load(a);
      Harness.setModel('test/model');
      const sending = Chat.send('What destination did we choose?');
      await delay(75);
      const beforeHistoryReady = requests.filter(r=>r.streamId===a.id).length;
      const latest = canonical.concat({role:'user',content:'Change destination to Titan.',sourceRunId:'remote-new'},
        {role:'assistant',content:'Titan is now the destination.',sourceRunId:'remote-new'});
      reads.shift()(latest); await sending; await delay(100);
      const sent = requests.find(r=>r.streamId===a.id);
      const modelContext = !!sent?.messages.some(m=>m.content==='Titan is now the destination.');
      const promptLast = sent?.messages.at(-1)?.content === 'What destination did we choose?';
      const input = document.getElementById('chat-input');
      input.value = 'Unsent draft stays in A'; input.focus(); input.dispatchEvent(new Event('input',{bubbles:true}));
      U.bus.emit('workshop.built',{agentId:'agent',runId:'reliability-background',manifest:{title:'Background result',files:[]}});
      await delay(100);
      const draftProtected = Workstreams.activeId()===a.id && input.value==='Unsent draft stays in A';
      input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
      // A send already admitted to A must not follow the next selected session.
      Chat.load(a); Harness.setModel('test/model');
      const crossed = Chat.send('Stay bound to A while I read B');
      Workstreams.switch(b.id);Chat.load(b);
      reads.shift()(a.history.slice()); await crossed;
      const bound = requests.filter(r=>r.messages?.at(-1)?.content==='Stay bound to A while I read B');
      const focusProtected = Workstreams.activeId()===b.id && b.history.length===0 && bound.length===1 && bound[0].streamId===a.id;
      // Failed restore refuses inference, retains the turn, and permits one explicit retry.
      offline=true; Workstreams.switch(a.id);Chat.load(a);Harness.setModel('test/model');
      const countBeforeFailure=requests.length;
      await Chat.send('Preserve this message through a failed restore');
      const unavailableProtected=requests.length===countBeforeFailure && a.history.some(m=>m.content==='Preserve this message through a failed restore');
      offline=false;Harness.setModel('test/model');
      const retry=Chat.send('Preserve this message through a failed restore',{retry:true});
      reads.shift()(a.history.filter(m=>!m.sys && !m.error));await retry;
      const retryOnce=requests.length===countBeforeFailure+1 && a.history.filter(m=>m.role==='user' && m.content==='Preserve this message through a failed restore').length===1;
      // Combine a recovered session with a stream that loses its completion event.
      truncated=true;Harness.setModel('test/model');await Chat.send('Retain a partial reply');
      const partialProtected=a.lastRunOk===false && a.history.some(m=>m.error) && !document.getElementById('chat-log').innerText.endsWith('RUN COMPLETE');
      saveOffline=true;App.persist();const failedSave=await CloudSave.flush({force:true});
      const localRetained=localStorage.getItem('starnet.save').includes('Retain a partial reply');
      saveOffline=false;App.persist(); const saved = await CloudSave.flush({force:true});
      return {id:a.id, neighbor:b.id, delayedVisible, beforeHistoryReady, modelContext, promptLast, draftProtected,focusProtected,unavailableProtected,retryOnce,partialProtected,failedSave,localRetained,saved,
        diagnostics:Chat.continuityDiagnostics(),
        history:a.history.map(m=>({role:m.role,content:m.content})), draft:document.getElementById('chat-input').value};
    } finally { window.fetch = realFetch; }
  }.toString()})()`);
  writeFileSync(resolve(out, 'live.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  // Force recovery from the acknowledged durable save, not the old browser cache.
  assert.equal(await evalJS(cdp, "localStorage.removeItem('starnet.save'); localStorage.getItem('starnet.save')"),null);
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await stop(); await boot(); await page();
  result.restart = await evalJS(cdp, `(() => { const w=Workstreams.get(${JSON.stringify(result.id)}); if(w) {Workstreams.switch(w.id);Chat.load(w);} return {exists:!!w,history:w?.history.map(m=>({role:m.role,content:m.content})),visible:document.getElementById('chat-log').innerText}; })()`);
  writeFileSync(resolve(out, 'live.json'), JSON.stringify(result, null, 2));
  assert.equal(result.delayedVisible, true, 'late transcript must become visible without a second session switch');
  assert.equal(result.beforeHistoryReady, 0, 'send must wait for the history it will use');
  assert.equal(result.modelContext, true, 'model request includes recovered conversation');
  assert.equal(result.promptLast, true, 'new directive remains last in the model request');
  assert.equal(result.saved, true, 'durable save acknowledged');
  assert.equal(result.failedSave,false,'failed durable write cannot claim saved');
  assert.equal(result.localRetained,true,'failed durable write keeps the local conversation');
  for (const key of ['draftProtected','focusProtected','unavailableProtected','retryOnce','partialProtected']) assert.equal(result[key],true,key);
  assert.deepEqual(result.restart.history, result.history, 'full conversation survives process restart');
  console.log('session-reliability: PASS (delayed restore, context, durable save, process restart)');
} finally {
  writeFileSync(resolve(out, 'boot.log'), log);
  if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.ws.close(); }
  if (browser) browser.kill();
  await stop();
  if (installed) await installed.dispose();
}
