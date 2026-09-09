/* Live UI regression against an isolated seeded station. Uses normal controls only;
 * no provider execution, synthetic app state, saved widget changes, or external accounts.
 * STARNET_PLAYWRIGHT_MODULE / STARNET_CHROME select locally available browser dependencies. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.STARNET_CHROME?{executablePath:process.env.STARNET_CHROME}:{})});
 const proof={url:process.argv[2] || 'http://127.0.0.1:9199/',cycles:[],geometry:[],errors:[]};
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'no-preference'});
  page.setDefaultTimeout(15000);
  page.on('pageerror',e=>proof.errors.push(e.message));
  await page.addInitScript(()=>{
   window.__glassFrames=[]; window.__glassLongTasks=[];
   let last;
   const sample=now=>{if(last && window.__glassFrames.length<12000)window.__glassFrames.push(now-last);last=now;requestAnimationFrame(sample);};
   requestAnimationFrame(sample);
   new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__glassLongTasks.push({start:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});
  });
  const ready=async()=>{await page.waitForSelector('#screen-game.active');await page.waitForSelector('#bottombar [data-group="system"]');};
  const phase=async name=>page.evaluate(name=>performance.mark('glass:'+name),name);
  const dialog=()=>page.locator('.term:not(.term-closing):not(.term-min-hidden)');
  const open=async(group,key)=>{await phase('open '+key);await page.locator('#bottombar [data-group="'+group+'"] > .bb-grp').click({force:true});await page.locator('#bottombar [data-term="'+key+'"]').click({force:true});await dialog().waitFor();};
  const close=async()=>{await phase('close window');await dialog().locator('.term-x').click({force:true});await page.waitForFunction(()=>!document.querySelector('.term'));};
  const settle=async()=>page.waitForFunction(()=>[...document.querySelectorAll('.term')].every(w=>w.style.willChange==='' && !w.classList.contains('term-closing') && !w.classList.contains('term-minimizing')));
  const geometry=async(label)=>{
   await settle();
   const r=await dialog().evaluate(w=>{const b=w.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,clientWidth:w.clientWidth,scrollWidth:w.scrollWidth};});
   assert(r.x>=-1 && r.y>=-1 && r.right<=r.viewportWidth+1 && r.bottom<=r.viewportHeight+1,label+' stays in viewport');
   assert(r.scrollWidth<=r.clientWidth+1,label+' has no horizontal overflow');proof.geometry.push({label,...r});return r;
  };
  await page.goto(proof.url);await ready();
  assert(await page.locator('body').evaluate(e=>e.classList.contains('glass-demo')),'default glass');
  assert.equal(await page.locator('.gd-badge').count(),0);
  await page.evaluate(()=>{window.__glassFrames=[];window.__glassLongTasks=[];});
  for(let i=0;i<5;i++){
   await open('system','settings');await settle();
   const before=await geometry('panel '+i);
   await phase('maximize');await dialog().getByRole('button',{name:'Maximize window',exact:true}).click();
   const expanded=await geometry('maximized '+i);assert(expanded.height>=before.height);
   await phase('restore size');await dialog().getByRole('button',{name:'Restore window size',exact:true}).click();
   await geometry('restored '+i);
   await dialog().getByRole('button',{name:'Minimize window',exact:true}).click({force:true});
   await page.locator('.term-chip[data-key="settings"]').click({force:true});
   await dialog().getByRole('button',{name:'Minimize window',exact:true}).click({force:true});
   await page.locator('.term-chip[data-key="settings"]:not(.out)').click({force:true});
   await settle();await page.waitForFunction(()=>!document.querySelector('.term-chip'));
   assert.equal(await dialog().count(),1);
   assert.equal(await dialog().getAttribute('inert'),null);
   await dialog().locator('.con-search-in').fill('');
   await dialog().locator('.con-search-in').press('Escape');
   assert(await dialog().evaluate(w=>document.activeElement===w),'Escape retains window focus');
   await dialog().press('Escape');
   // Reopen during exit: only the departing DOM node may be removed by its old completion.
   await open('system','settings');await settle();assert.equal(await dialog().count(),1);
   await close();
   assert.equal(await page.locator('.term-chip').count(),0);
   proof.cycles.push({cycle:i+1,rapidCloseReopen:true,rapidMinimizeRestore:true,escape:true});
  }
  for(const [group,key] of [['work','deliverables'],['build','connectors']]){
   await open(group,key);await geometry(key);
   const bare=await dialog().locator('button,input,textarea,select').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width).filter(e=>{const s=getComputedStyle(e);return ['rgb(255, 255, 255)','rgb(239, 239, 239)'].includes(s.backgroundColor)||s.borderColor==='rgb(118, 118, 118)';}).length);
   assert.equal(bare,0,key+' has no browser-default control paint');await close();
  }
  for(const rail of ['wr-top','wr-bot']){
   await phase('widget '+rail);
   await page.locator('#'+rail+' .wg-add').click();
   await page.locator('.wg-library-search').fill('no matching widget');
   assert.equal(await page.locator('.wg-library-list').innerText(),'No matching widgets.');
   for(const kind of ['apps','pinned','main'])await page.locator('[data-widget-tab="'+kind+'"]').click();
   await page.locator('.wg-library-search').press('Escape');
   assert.equal(await page.locator('.wg-library').count(),0);
   assert(await page.locator('#'+rail+' .wg-add').evaluate(e=>document.activeElement===e));
  }
  await phase('model picker');await page.locator('#model-dock-toggle').click();
  await page.locator('#model-dock-search').fill('no matching model for glass check');
  await page.waitForFunction(()=>document.querySelector('#model-dock-list').textContent.includes('NO MATCHES'));
  await page.locator('#model-dock-search').fill('');
  await page.locator('#model-dock-search').press('Escape');
  assert(await page.locator('#model-dock-toggle').evaluate(e=>document.activeElement===e));
  await phase('slash menu');await page.locator('#chat-input').fill('/model');await page.locator('#chat-input').press('Escape');await page.locator('#chat-input').fill('');
  // A resize or text-scale change must keep the close/maximize controls reachable.
  for(const width of [899,640,390]){
   await phase('viewport '+width);await page.setViewportSize({width,height:900});await open('system','settings');await geometry('viewport '+width);
   await dialog().locator('.gd-pull').press('End');await geometry('viewport '+width+' expanded');
   await dialog().locator('.gd-pull').press('Home');await geometry('viewport '+width+' compact');await close();
  }
  await page.setViewportSize({width:1280,height:900});
  await open('system','settings');
  await phase('appearance settings');await dialog().getByText('APPEARANCE',{exact:true}).first().click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#set-backdrop canvas')].every(c=>c.dataset.previewSource==='worker'));
  proof.backdropWorkerCanvases=await page.locator('#set-backdrop canvas[data-preview-source="worker"]').count();
  const savedScale=await dialog().locator('#set-textsize .sel').getAttribute('data-ts');
  const profiler=await page.context().newCDPSession(page);
  await profiler.send('Profiler.enable');await profiler.send('Profiler.start');
  await phase('text size 145');await dialog().locator('#set-textsize [data-ts="145"]').click();
  await geometry('145 percent text');
  await dialog().getByRole('button',{name:'Maximize window',exact:true}).click();
  await geometry('145 percent text expanded');
  await phase('restore text size');
  await dialog().locator('#set-textsize [data-ts="'+savedScale+'"]').click();await close();
  const {profile}=await profiler.send('Profiler.stop');await profiler.detach();
  const self=new Map();(profile.samples||[]).forEach((id,i)=>self.set(id,(self.get(id)||0)+(profile.timeDeltas?.[i]||0)));
  proof.textResizeCpu=profile.nodes.map(n=>({function:n.callFrame.functionName,url:n.callFrame.url.split('/').slice(-2).join('/'),line:n.callFrame.lineNumber+1,selfMs:(self.get(n.id)||0)/1000})).sort((a,b)=>b.selfMs-a.selfMs).slice(0,12);

  proof.performance=await page.evaluate(()=>{const f=window.__glassFrames.filter(n=>n>0).sort((a,b)=>a-b);const marks=performance.getEntriesByType('mark').filter(m=>m.name.startsWith('glass:'));const tasks=window.__glassLongTasks.map(t=>({...t,phase:marks.findLast(m=>m.startTime<=t.start)?.name||'unmarked'}));return {frames:f.length,p95FrameMs:f[Math.floor(f.length*.95)]||null,longTasks:tasks.length,slowest:tasks.sort((a,b)=>b.duration-a.duration).slice(0,10)};});
  await page.emulateMedia({reducedMotion:'reduce'});await open('system','settings');await geometry('reduced motion');
  assert.equal(await dialog().evaluate(e=>e.getAnimations().length),0);
  await close();
  const fallback=new URL(proof.url);fallback.searchParams.set('glass','0');await page.goto(fallback.href);await ready();
  assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('glass-demo')),false);
  await open('system','settings');assert.equal(await page.locator('.gd-sheet').count(),0);await close();
  await page.goto(proof.url);await ready();
  assert.deepEqual(proof.errors,[],'no uncaught browser errors');
  proof.pass=true; console.log(JSON.stringify(proof,null,2));
 } catch(error){proof.pass=false;proof.failure=error.stack;console.log(JSON.stringify(proof,null,2));process.exitCode=1;}
 finally {await browser.close();}
})();
