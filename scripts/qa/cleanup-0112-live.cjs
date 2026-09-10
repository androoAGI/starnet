'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.STARNET_CHROME?{executablePath:process.env.STARNET_CHROME}:{})});
 const proof={source:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),errors:[]};
 try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>proof.errors.push(e.message));
 await page.goto(process.argv[2] || 'http://127.0.0.1:19312/'); await page.waitForSelector('#screen-game.active');
 const open=async()=>{await page.locator('#bottombar [data-group="system"] > .bb-grp').click();await page.locator('#bottombar [data-term="settings"]').click();await page.locator('.term:not(.term-closing)').waitFor();await page.waitForTimeout(350);};
 const close=async()=>{await page.locator('.term:not(.term-closing) .term-x').click();await page.waitForFunction(()=>!document.querySelector('.term'));};
 await open();
 proof.resize={before:await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height)};
 await page.locator('.gd-pull').press('ArrowUp');await page.locator('.gd-pull').press('ArrowUp');
 proof.resize.resized=await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height);
 await close();await open();proof.resize.reopened=await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height);
 assert.equal(proof.resize.reopened,proof.resize.resized);
 await close();await page.reload();await page.waitForSelector('#screen-game.active');await open();
 proof.resize.reloaded=await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height);assert.equal(proof.resize.reloaded,proof.resize.resized);
 await page.getByRole('button',{name:'Maximize window',exact:true}).click();await close();await page.reload();await page.waitForSelector('#screen-game.active');await open();
 assert.equal(await page.getByRole('button',{name:'Restore window size',exact:true}).getAttribute('aria-expanded'),'true');
 await page.getByRole('button',{name:'Restore window size',exact:true}).click();assert.equal(await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height),proof.resize.resized);
 await page.setViewportSize({width:1000,height:600});await page.waitForTimeout(100);
 assert.ok(await page.locator('.term').evaluate(w=>w.getBoundingClientRect().bottom<=innerHeight && w.getBoundingClientRect().top>=0));
 await close();
 proof.race=await page.evaluate(async()=>{
  const old=Harness.apiFetch, oldList=Harness.listModels, applied=[];
  let release,startedResolve;const started=new Promise(r=>startedResolve=r);const hold=new Promise(r=>release=r);
  const catalog=p=>({models:p==='ollama'?[{id:'qwen3:14b'}]:p==='starnet'?[{id:'anthropic/test-model'}]:[],...(['ollama','starnet'].includes(p)?{}:{error:'not configured'})});
  Harness.listModels=async()=>[];
  Harness.apiFetch=async url=>{
   if(url==='/api/models/ollama'){startedResolve();await hold;return new Response(JSON.stringify(catalog('ollama')),{status:200});}
   if(url.startsWith('/api/models/'))return new Response(JSON.stringify(catalog(url.split('/').pop())),{status:200});
   if(url.includes('/api/auth/'))return new Response(JSON.stringify({connected:false}),{status:200});
   return old(url);
  };
  Harness.setProv('ollama');Harness.setModel('qwen3:14b');
  const pending=ModelDock.refresh();await started;
  Harness.setProv('starnet');Harness.setModel('anthropic/test-model');
  const chosen={provider:Harness.getProv(),model:Harness.getModel()};release();await pending;
  const after={provider:Harness.getProv(),model:Harness.getModel()};
  Harness.apiFetch=old;Harness.listModels=oldList;
  return {chosen,after};
 });
 assert.deepEqual(proof.race.after,proof.race.chosen);
 }finally{await browser.close();fs.writeFileSync('.dogfood/cleanup-live.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1});
