'use strict';
const fs=require('node:fs');
const {chromium}=require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.STARNET_CHROME?{executablePath:process.env.STARNET_CHROME}:{})});
 const proof={source:'b3760c46ff3fe02790e6c3b0c50a23c30b5837a8',errors:[]};
 try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>proof.errors.push(e.message));
 await page.goto(process.argv[2] || 'http://127.0.0.1:19312/'); await page.waitForSelector('#screen-game.active');
 const open=async()=>{await page.locator('#bottombar [data-group="system"] > .bb-grp').click();await page.locator('#bottombar [data-term="settings"]').click();await page.locator('.term:not(.term-closing)').waitFor();await page.waitForTimeout(350);};
 const close=async()=>{await page.locator('.term:not(.term-closing) .term-x').click();await page.waitForFunction(()=>!document.querySelector('.term'));};
 await open();
 proof.resize={before:await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height)};
 await page.locator('.gd-pull').press('ArrowUp');await page.locator('.gd-pull').press('ArrowUp');
 proof.resize.resized=await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height);
 await close();await open();proof.resize.reopened=await page.locator('.term').evaluate(w=>w.getBoundingClientRect().height);await close();
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
 }finally{await browser.close();fs.writeFileSync('qa/evidence/0.11.2-audit/audit-live-probes.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1});
