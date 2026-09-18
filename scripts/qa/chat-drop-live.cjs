// Isolated dev/seed.js --keep. Real file upload/read-back; inference transport is a local fixture.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { chromium } = require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const baseline = process.argv.includes('--baseline');
  const browser = await chromium.launch({headless:true, channel:'msedge'});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:832}});
    await page.addInitScript(() => {
      Element.prototype.requestPointerLock = () => Promise.reject(new Error('Disabled in isolated QA'));
      if (navigator.keyboard) navigator.keyboard.lock = () => Promise.reject(new Error('Disabled in isolated QA'));
      window.open = () => null;
    });
    if (baseline) await page.route('**/app/chat.js', r => r.fulfill({status:200, contentType:'application/javascript', body:cp.execFileSync('git',['show','3ba5b8492:frontend/app/chat.js'],{encoding:'utf8',maxBuffer:4*1024*1024})}));
    const uploaded = [], errors = [];
    async function waitUploads(count) {
      const until=Date.now()+5000;
      while(uploaded.length<count&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(uploaded.length,count);
    }
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', async r => { if (r.url().endsWith('/api/attachments') && r.request().method() === 'POST') { const j=await r.json().catch(()=>({})); if(j.path) uploaded.push(j); } });
    await page.goto(process.argv[2] || 'http://127.0.0.1:18973');
    await page.waitForFunction(() => typeof Chat === 'object' && document.querySelector('#screen-game.active'));
    await page.waitForTimeout(1500);
    await page.locator('#chat-input').fill('Keep my draft');
    const proof = {baseline, transport:'Headless Chromium drag events; real sidecar uploads; local inference fixture', checks:[]};
    if (baseline) {
      await page.evaluate(() => {
        const dataTransfer=new DataTransfer();dataTransfer.items.add(new File(['drop proof'],'notes.txt',{type:'text/plain'}));
        for(const type of ['dragenter','dragover','drop'])document.querySelector('#chat-log').dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer}));
      });
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.chat-attach-chip').count(),0);
      proof.checks.push('Baseline reproduced: transcript drop attaches nothing');
      console.log(JSON.stringify(proof,null,2));return;
    }
    const dir=path.resolve('.dogfood/chat-drop');fs.mkdirSync(dir,{recursive:true});
    const textPath=path.join(dir,'drop-proof.txt'), pngPath=path.join(dir,'drop-pixel.png');
    fs.writeFileSync(textPath,'StarNet real file drop proof');
    fs.writeFileSync(pngPath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=','base64'));
    const cdp=await page.context().newCDPSession(page);
    const box=await page.locator('#chat-log').boundingBox();
    const data={items:[],files:[textPath,pngPath],dragOperationsMask:1};
    for(const type of ['dragEnter','dragOver'])await cdp.send('Input.dispatchDragEvent',{type,x:box.x+box.width/2,y:box.y+box.height/2,data});
    assert.equal(await page.locator('.chat-drop-hint').isVisible(),true);
    const overlay=await page.locator('.chat-drop-hint').evaluate(e=>({text:e.textContent,pointerEvents:getComputedStyle(e).pointerEvents,background:getComputedStyle(e).backgroundColor}));
    assert.equal(overlay.pointerEvents,'none'); assert.notEqual(overlay.background,'rgb(255, 255, 255)');
    await cdp.send('Input.dispatchDragEvent',{type:'drop',x:box.x+box.width/2,y:box.y+box.height/2,data});
    await page.waitForFunction(()=>document.querySelectorAll('.chat-attach-chip').length===2&&!document.querySelector('.chat-attach-chip.uploading'));
    assert.equal(await page.locator('.chat-attach-chip.err').count(),0);
    await page.waitForFunction(()=>{const img=document.querySelector('.chat-attach-chip img');return img&&img.complete&&img.naturalWidth>0;});
    assert.equal(await page.locator('#chat-input').inputValue(),'Keep my draft');
    assert.equal(await page.locator('.chat-drop-hint').isVisible(),false);
    await waitUploads(2);
    for(const ref of uploaded){
      const bytes=await page.evaluate(async ref=>{const r=await fetch('/api/file?agent=agent&path='+encodeURIComponent(ref.path)+'&token='+encodeURIComponent(Harness.apiToken()));return {status:r.status,bytes:Array.from(new Uint8Array(await r.arrayBuffer()))};},ref);
      assert.equal(bytes.status,200);assert.deepEqual(Buffer.from(bytes.bytes),fs.readFileSync(ref.name==='drop-proof.txt'?textPath:pngPath));
    }
    proof.checks.push('Transcript drop: two real files uploaded exactly once; exact bytes read back; image preview; draft preserved; overlay clears');proof.overlay=overlay;
    await page.evaluate(()=>{window.dropRuns=[];Harness.chat=async o=>{if(!o.streamId)return {text:'Auxiliary fixture',endReason:'done'};dropRuns.push(o);o.onRunId('drop-live-proof');return {text:'Attachment verification fixture.',endReason:'done'};};});
    await page.locator('#chat-send').click();
    await page.waitForFunction(()=>dropRuns.length===1&&!Chat.isBusy());
    const sent=await page.evaluate(()=>{const w=Workstreams.get(Workstreams.activeId());const m=w.history.find(m=>m.role==='user'&&m.content==='Keep my draft');return {names:m.attachments.map(a=>a.name),strip:document.querySelectorAll('.chat-attach-chip').length};});
    assert.deepEqual(sent.names.sort(),['drop-pixel.png','drop-proof.txt']);assert.equal(sent.strip,0);
    proof.checks.push('Real composer sends both attachment references on the intended user turn (inference stubbed)');
    // Existing picker and paste share staging; re-enter chat first to catch duplicate handlers.
    await page.evaluate(()=>{const w=Workstreams.create('Drop re-entry',{activate:false});App.openWorkstream(w.id);});
    await page.locator('#chat-attach-input').setInputFiles(textPath);
    await page.evaluate(()=>{const dataTransfer=new DataTransfer();dataTransfer.items.add(new File(['paste proof'],'paste.txt',{type:'text/plain'}));document.querySelector('#chat-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dataTransfer}));});
    await page.waitForFunction(()=>document.querySelectorAll('.chat-attach-chip').length===2&&!document.querySelector('.chat-attach-chip.uploading'));
    await waitUploads(4);proof.checks.push('Picker and paste still upload once after session re-entry');
    const url=page.url();const outside=await page.locator('#stage-wrap').boundingBox();
    for(const type of ['dragEnter','dragOver','drop'])await cdp.send('Input.dispatchDragEvent',{type,x:outside.x+outside.width/2,y:outside.y+outside.height/2,data});
    assert.equal(page.url(),url);assert.equal(uploaded.length,4);proof.checks.push('Drop outside chat does not navigate or attach');
    // A send during a pending dropped-file upload must wait for its real reference.
    let releaseUpload;
    const holdUpload=new Promise(resolve=>{releaseUpload=resolve;});
    await page.route('**/api/attachments',async r=>{if(r.request().postDataJSON()?.name==='delayed.txt')await holdUpload;await r.continue();});
    await page.evaluate(()=>{const dataTransfer=new DataTransfer();dataTransfer.items.add(new File(['pending upload proof'],'delayed.txt',{type:'text/plain'}));document.querySelector('#chat-input').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));});
    await page.waitForFunction(()=>document.querySelector('.chat-attach-chip.uploading'));
    await page.locator('#chat-input').fill('Wait for all my files');await page.locator('#chat-send').click();
    assert.equal(await page.evaluate(()=>dropRuns.length),1);releaseUpload();
    await page.waitForFunction(()=>dropRuns.length===2&&!Chat.isBusy());
    const delayed=await page.evaluate(()=>Workstreams.get(Workstreams.activeId()).history.find(m=>m.content==='Wait for all my files').attachments.map(a=>a.name).sort());
    assert.deepEqual(delayed,['delayed.txt','drop-proof.txt','paste.txt']);
    proof.checks.push('Composer drop uploads once after re-entry; Send waits for the delayed upload and includes all three refs');
    await page.evaluate(()=>{const dataTransfer=new DataTransfer();dataTransfer.items.add(new File([new Uint8Array(8*1024*1024+1)],'too-large.txt',{type:'text/plain'}));document.querySelector('#chat-log').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));});
    assert.equal(await page.locator('.chat-attach-chip').count(),0);
    await page.locator('.toast').filter({hasText:'too-large.txt'}).waitFor({state:'visible'});
    proof.checks.push('Dropped oversized file uses the existing 8MB rejection and stages nothing');
    proof.pageErrors=errors;console.log(JSON.stringify(proof,null,2));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
