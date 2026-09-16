/* Isolated dev/seed.js --keep only. Real UI/stores, controlled delivery and connector/model transport.
   STARNET_PLAYWRIGHT_MODULE and STARNET_CHROME select local test dependencies.
   --baseline serves the original workshop/chat sources from 1cbd6384d to prove the reported failure. */
'use strict';
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const {chromium}=require(process.env.STARNET_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const baseline=process.argv.includes('--baseline');
  const browser=await chromium.launch({headless:true,...(process.env.STARNET_CHROME?{executablePath:process.env.STARNET_CHROME}:{})});
  try {
    const page=await browser.newPage(), errors=[], proof={baseline,transport:'controlled local fixtures; no paid model',source:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
    page.on('pageerror',e=>errors.push(e.message));
    if(baseline)for(const file of ['chat.js','workshopstore.js']){
      const body=cp.execFileSync('git',['show','1cbd6384d:frontend/app/'+file],{encoding:'utf8'});
      await page.route('**/app/'+file,r=>r.fulfill({status:200,contentType:'application/javascript',body}));
    }
    let pending=[];
    await page.route('**/api/workshop/pending*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({pending})}));
    await page.goto(process.argv[2]||'http://127.0.0.1:18967');
    await page.waitForFunction(()=>typeof Chat==='object'&&document.querySelector('#screen-game.active'));
    await page.waitForTimeout(2500);
    const original=await page.evaluate(()=>{const w=Workstreams.create('Typing safety original',{activate:false});App.openWorkstream(w.id);return w.id;});
    const input=page.locator('#chat-input');
    await input.fill('Keep this draft in the original session');
    async function deliver(runId){await page.evaluate(runId=>U.bus.emit('workshop.built',{agentId:'agent',runId,manifest:{title:'Typing safety '+runId,files:[]}}),runId);}
    async function snapshot(){return page.evaluate(()=>({selected:Workstreams.activeId(),draft:document.querySelector('#chat-input').value,focused:document.activeElement===document.querySelector('#chat-input'),attachments:document.querySelectorAll('.chat-attach-chip').length}));}
    await deliver('typing-live'); proof.liveDraft=await snapshot();
    if(baseline){assert.notEqual(proof.liveDraft.selected,original,'baseline must reproduce session theft');proof.expectedFailure='Delivery moved the selected session while typing';console.log(JSON.stringify(proof,null,2));return;}
    assert.equal(proof.liveDraft.selected,original);assert.equal(proof.liveDraft.draft,'Keep this draft in the original session');assert.equal(proof.liveDraft.focused,true);
    await input.fill('');await deliver('typing-empty');proof.focusedEmpty=await snapshot();assert.equal(proof.focusedEmpty.selected,original);assert.equal(proof.focusedEmpty.focused,true);
    await input.fill('Draft survives a poll too');await input.evaluate(e=>e.blur());
    pending=[{agentId:'agent',runId:'typing-poll',title:'Typing poll',files:[]}];
    await page.evaluate(async()=>{WorkshopStore.reset();await WorkshopStore._maybePresent();await WorkshopStore.presentOnReturn();});
    proof.polls=await snapshot();assert.equal(proof.polls.selected,original);assert.equal(proof.polls.draft,'Draft survives a poll too');
    await page.route('**/api/attachments',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,id:'typing-file',name:'proof.txt',path:'proof.txt',mediaType:'text/plain',kind:'file'})}));
    await page.locator('#chat-attach-input').setInputFiles({name:'proof.txt',mimeType:'text/plain',buffer:Buffer.from('typing safety fixture')});
    await page.waitForFunction(()=>document.querySelector('.chat-attach-chip')&&!document.querySelector('.chat-attach-chip.uploading'));
    await input.fill('');await input.evaluate(e=>e.blur());await deliver('typing-attachment');
    proof.attachment=await snapshot();assert.equal(proof.attachment.selected,original);assert.equal(proof.attachment.attachments,1);
    // Send through the actual composer; only replace inference transport, retaining routing and history.
    await page.evaluate(()=>{window.typingRuns=[];Harness.chat=async o=>{if(!o.streamId)return {text:'Local auxiliary fixture.',endReason:'done'};const id='typing-proof-'+(typingRuns.length+1);typingRuns.push({streamId:o.streamId,messages:o.messages});o.onRunId(id);return {text:'Local verification reply.',endReason:'done'};};});
    await input.fill('This belongs to the original session');await page.locator('#chat-send').click();
    await page.waitForFunction(()=>typingRuns.length===1&&!Chat.isBusy()).catch(async e=>{console.error(await page.evaluate(()=>({runs:typingRuns,busy:Chat.isBusy(),input:document.querySelector('#chat-input').value,tail:document.querySelector('#chat-log')?.innerText.slice(-2000)})));throw e;});
    proof.nextSend=await page.evaluate(original=>({stream:typingRuns[0].streamId,originalHasTurn:Workstreams.get(original).history.some(m=>m.content==='This belongs to the original session'),deliveryHasTurn:Workstreams.get('workshop-typing-live').history.some(m=>m.content==='This belongs to the original session')}),original);
    assert.equal(proof.nextSend.stream,original);assert.equal(proof.nextSend.originalHasTurn,true);assert.equal(proof.nextSend.deliveryHasTurn,false);
    // Explicit review remains available despite a new draft.
    await input.fill('Draft before explicit review');
    const toast=page.locator('.toast').filter({hasText:'Typing safety typing-attachment'});
    if(await toast.count())await toast.last().click();
    else await page.evaluate(()=>App.openWorkstream('workshop-typing-attachment')); // same explicit rail action
    assert.equal((await snapshot()).selected,'workshop-typing-attachment');proof.explicitReview=true;

    const target=await page.evaluate(original=>{App.openWorkstream(original);const w=Workstreams.create('Connector typing target',{activate:false});Workstreams.appendRun(w.id,'connector-source');Workstreams.setConnectorHandoff(w.id,{connectorId:'fixture',agentId:'agent',runId:'connector-source',toolName:'read'});window.connectorGet=Harness.api.get;Harness.api.get=url=>url==='/api/connectors'?new Promise(resolve=>{window.releaseConnector=()=>resolve({connectors:[{id:'fixture',state:'up',enabled:true,tools:['read']}]});}):connectorGet(url);return w.id;},original);
    await input.fill('');await input.evaluate(e=>e.blur());
    await page.evaluate(target=>{window.continuationDone=null;Chat.continueConnectorTask(target).then(v=>window.continuationDone=v);},target);
    await page.waitForFunction(()=>typeof releaseConnector==='function');await input.fill('New typing while the connector was checked');
    await page.evaluate(()=>releaseConnector());await page.waitForFunction(()=>continuationDone!==null);
    proof.connector=await snapshot();proof.connector.result=await page.evaluate(()=>continuationDone);
    proof.connector.handoffRetained=await page.evaluate(target=>!!Workstreams.connectorHandoff(target),target);
    assert.equal(proof.connector.selected,original);assert.equal(proof.connector.result,false);assert.equal(proof.connector.handoffRetained,true);assert.equal(proof.connector.draft,'New typing while the connector was checked');
    await input.fill('');await input.evaluate(e=>e.blur());
    await page.evaluate(target=>{window.continuationDone=null;Chat.continueConnectorTask(target).then(v=>window.continuationDone=v);},target);
    await page.evaluate(()=>releaseConnector());await page.waitForFunction(()=>continuationDone!==null);
    proof.retry=await page.evaluate(target=>({result:continuationDone,selected:Workstreams.activeId()===target,cleared:!Workstreams.connectorHandoff(target),runs:typingRuns.length}),target);
    assert.deepEqual(proof.retry,{result:true,selected:true,cleared:true,runs:2});
    pending=[];await page.evaluate(()=>App.persist());await page.waitForTimeout(1000);await page.reload();
    await page.waitForFunction(()=>typeof Chat==='object'&&document.querySelector('#screen-game.active'));
    proof.reload=await page.evaluate(original=>({historyKept:!!Workstreams.get(original)?.history.some(m=>m.content==='This belongs to the original session')}),original);
    assert.equal(proof.reload.historyKept,true);proof.errors=errors;assert.deepEqual(errors,[]);
    console.log(JSON.stringify(proof,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
