/* Run against an ISOLATED dev/seed.js --keep station only.
 * STARNET_PLAYWRIGHT_MODULE may point to a bundled Playwright package.
 * STARNET_CHROME may point to a local Chrome executable. No microphone or paid model is used.
 * We expose the unchanged voice callback for deterministic delivery and substitute only Harness.chat's
 * transport; session stores, composer, run metadata, station tool/handler, DOM, and saves run normally.
 */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
const { makeStationTools } = require('../../sidecar/tools/builtin/station.js');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.STARNET_CHROME ? {executablePath:process.env.STARNET_CHROME} : {})});
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const acks = [], errors = [], proof = {};
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/app/voice-live.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const marker = 'return { init, start, end, isActive:';
      assert.ok(source.includes(marker));
      await route.fulfill({response, body:source.replace(marker, 'return { proofBind: bindSession, proofReply: onAssistant, init, start, end, isActive:')});
    });
    await page.route('**/api/station/ack', async route => {
      acks.push(route.request().postDataJSON());
      await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
    });
    await page.goto(process.argv[2] || 'http://127.0.0.1:18949');
    await page.waitForFunction(() => typeof Chat === 'object' && document.querySelector('#screen-game.active'));
    await page.waitForTimeout(5000);
    const ids = await page.evaluate(() => {
      const a = Workstreams.create('Focus proof call', {activate:false});
      const b = Workstreams.create('Focus proof reading', {activate:false});
      App.openWorkstream(a.id); VoiceLive.proofBind(); App.openWorkstream(b.id);
      return {a:a.id,b:b.id};
    });
    await page.locator('#chat-input').fill('Draft for the reading session');
    proof.delayedReply = await page.evaluate(ids => {
      VoiceLive.proofReply({text:'The background answer arrived.',opening:true});
      return {selected:Workstreams.activeId()===ids.b,draft:document.querySelector('#chat-input').value,bindingPreserved:VoiceLive.boundSessionId()===ids.a};
    }, ids);
    assert.equal(proof.delayedReply.selected,true);
    assert.equal(proof.delayedReply.draft,'Draft for the reading session');
    assert.equal(proof.delayedReply.bindingPreserved,true);

    // Start through the real Chat pipeline; hold the model transport after confirming a run id.
    await page.evaluate(() => {
      window.proofRuns = [];
      Harness.chat = async opts => { const id='focus-proof-'+(window.proofRuns.length+1); window.proofRuns.push({id,streamId:opts.streamId}); opts.onRunId(id); await new Promise(()=>{}); };
    });
    async function start(title) {
      const id = await page.evaluate(title => {const w=Workstreams.create(title,{activate:false});App.openWorkstream(w.id);Chat.send('hello');return w.id;}, title);
      await page.waitForFunction(id => window.proofRuns.some(r=>r.streamId===id), id);
      return page.evaluate(id=>({streamId:id,runId:Channels.runIdOf(id)}),id);
    }
    let seq=0;
    const tools=makeStationTools({station:{request:async (verb,args)=>{
      const id='focus-proof-command-'+(++seq);
      await page.evaluate(({id,verb,args})=>StationCommands.run(id,verb,args),{id,verb,args});
      return acks.find(a=>a.id===id);
    }}});
    const foreground=await start('Focus proof foreground');
    const opened=await tools.focusTool.run({session:ids.a},foreground);
    proof.currentRequest={accepted:!opened.content.startsWith('REFUSED:'),selected:await page.evaluate(id=>Workstreams.activeId()===id,ids.a)};
    assert.deepEqual(proof.currentRequest,{accepted:true,selected:true});

    const old=await start('Focus proof old run');
    await page.evaluate(ids=>App.openWorkstream(ids.b),ids);
    await page.locator('#chat-input').fill('Draft kept through background commands');
    const denied=await tools.focusTool.run({session:ids.a},old);
    const count=await page.evaluate(()=>Workstreams.list().length);
    const deniedCreate=await tools.createTool.run({title:'Stale focused create',focus:true},old);
    proof.backgroundRequest={refused:denied.content.startsWith('REFUSED:'),createRefused:deniedCreate.content.startsWith('REFUSED:'),noPartialCreate:await page.evaluate(n=>Workstreams.list().length===n,count),selected:await page.evaluate(id=>Workstreams.activeId()===id,ids.b),draft:await page.locator('#chat-input').inputValue()};
    assert.ok(proof.backgroundRequest.refused&&proof.backgroundRequest.createRefused&&proof.backgroundRequest.noPartialCreate&&proof.backgroundRequest.selected);
    assert.equal(proof.backgroundRequest.draft,'Draft kept through background commands');
    await page.evaluate(id=>App.openWorkstream(id),old.streamId);
    const late=await tools.focusTool.run({session:ids.a},old);
    proof.returnToOldRun={refused:late.content.startsWith('REFUSED:')};
    assert.equal(proof.returnToOldRun.refused,true);

    const typing=await start('Focus proof typing');
    await page.locator('#chat-input').fill('Unsent follow-up');
    const draftDenied=await tools.focusTool.run({session:ids.a},typing);
    proof.currentDraft={refused:draftDenied.content.startsWith('REFUSED:'),draft:await page.locator('#chat-input').inputValue()};
    assert.equal(proof.currentDraft.refused,true);assert.equal(proof.currentDraft.draft,'Unsent follow-up');

    const uploadOrigin=await page.evaluate(()=>{const w=Workstreams.create('Focus proof upload',{activate:false});App.openWorkstream(w.id);return w.id;});
    let releaseUpload; const uploadHeld=new Promise(resolve=>{releaseUpload=resolve;});
    await page.route('**/api/attachments',async route=>{await uploadHeld;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,id:'focus-proof-file',name:'proof.txt',path:'proof.txt',mediaType:'text/plain',kind:'file'})});});
    await page.locator('#chat-attach-input').setInputFiles({name:'proof.txt',mimeType:'text/plain',buffer:Buffer.from('local test attachment')});
    await page.locator('#chat-input').fill('Submitted for upload origin');
    await page.locator('#chat-send').click();
    await page.evaluate(ids=>App.openWorkstream(ids.b),ids);
    await page.locator('#chat-input').fill('Keep this separate draft');
    releaseUpload();
    await page.waitForFunction(()=>!document.querySelector('.chat-attach-chip.uploading'));
    proof.uploadNavigation=await page.evaluate(({ids,uploadOrigin})=>({selected:Workstreams.activeId()===ids.b,draft:document.querySelector('#chat-input').value,crossPosted:Workstreams.get(ids.b).history.some(m=>m.content==='Submitted for upload origin'),submitted:Workstreams.get(uploadOrigin).history.some(m=>m.content==='Submitted for upload origin')}),{ids,uploadOrigin});
    assert.equal(proof.uploadNavigation.crossPosted,false);assert.equal(proof.uploadNavigation.submitted,false);
    assert.equal(proof.uploadNavigation.draft,'Keep this separate draft');
    proof.errors=errors;assert.deepEqual(errors,[]);
    console.log(JSON.stringify(proof,null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});